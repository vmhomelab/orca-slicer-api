import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";
import unzipper from "unzipper";
import { AppError } from "../../middleware/error";

const BUNDLE_ID_PATTERN = /^[a-f0-9]{16}$/;
const MAX_BUNDLE_BYTES = 10_000_000;
const MAX_ARCHIVE_ENTRIES = 100;
const MAX_UNCOMPRESSED_BYTES = 50_000_000;
const MAX_COMPRESSION_RATIO = 100;
const BUNDLE_STORE = path.join(process.env.DATA_PATH || path.join(process.cwd(), "data"), "bundles");

type BundleSummary = {
  id: string;
  printer_preset_name: string;
  printer: string[];
  process: string[];
  filament: string[];
  version?: string;
};

type BundleManifest = Omit<BundleSummary, "id">;
type ProfileCategory = "printer" | "process" | "filament";
type ProfileReference = { name: string; path: string };
type MaterializedBundleManifest = BundleManifest & {
  profiles: Record<ProfileCategory, ProfileReference[]>;
};

export type ResolvedBundleProfiles = {
  printer: Buffer;
  preset: Buffer;
  filaments: Buffer[];
};

/**
 * Supported materializable .bbscfg schema (no vendor layout is inferred):
 *
 * {
 *   "printer_preset_name": "...", "printer": ["..."], "process": ["..."],
 *   "filament": ["..."],
 *   "profiles": {
 *     "printer": [{ "name": "...", "path": "profiles/printer.json" }],
 *     "process": [{ "name": "...", "path": "profiles/process.json" }],
 *     "filament": [{ "name": "...", "path": "profiles/filament.json" }]
 *   }
 * }
 *
 * Each path must name one safe archive entry. Resolver lookups use only these
 * explicit paths, never request-supplied profile names. Name-only manifests are
 * still accepted for listing/backward compatibility, but cannot be sliced.
 */
export async function saveBundle(buffer: Buffer): Promise<{ summary: BundleSummary; created: boolean }> {
  if (buffer.length === 0 || buffer.length > MAX_BUNDLE_BYTES) {
    throw new AppError(400, "Bundle exceeds the 10 MB upload limit");
  }
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new AppError(400, "Bundle must be a valid ZIP archive");
  }

  const manifest = await validateBundleArchive(buffer);
  const id = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const summary: BundleSummary = { id, ...summaryFromManifest(manifest) };
  const bundlePath = storedBundlePath(id);
  const summaryPath = storedSummaryPath(id);
  await fs.mkdir(BUNDLE_STORE, { recursive: true });

  try {
    await fs.writeFile(bundlePath, buffer, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.readFile(bundlePath);
    if (!existing.equals(buffer)) throw new AppError(400, "Bundle id collision");
    return { summary: await readBundleSummary(id), created: false };
  }

  try {
    await fs.writeFile(summaryPath, JSON.stringify(summary), { flag: "wx" });
  } catch (error) {
    await fs.unlink(bundlePath).catch(() => undefined);
    throw error;
  }
  return { summary, created: true };
}

export async function resolveBundleProfiles(
  id: string,
  printerName: string,
  processName: string,
  filamentNames: string[],
): Promise<ResolvedBundleProfiles> {
  validateBundleId(id);
  let archive: Buffer;
  try {
    archive = await fs.readFile(storedBundlePath(id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "Bundle not found");
    throw error;
  }

  const { directory, manifest } = await openBundleArchive(archive);
  if (!isMaterializedManifest(manifest)) {
    throw new AppError(400, "This legacy bundle cannot be sliced because it has no supported profile mapping manifest");
  }

  const printer = await resolveMappedProfile(directory, manifest.profiles.printer, printerName, "printer");
  const preset = await resolveMappedProfile(directory, manifest.profiles.process, processName, "process");
  if (!Array.isArray(filamentNames) || filamentNames.length === 0 || filamentNames.length > 16) {
    throw new AppError(400, "Bundle must select between 1 and 16 filament profiles");
  }
  const filaments = await Promise.all(
    filamentNames.map((name) => resolveMappedProfile(directory, manifest.profiles.filament, name, "filament")),
  );
  return { printer, preset, filaments };
}

export async function listBundles(): Promise<BundleSummary[]> {
  try {
    const entries = await fs.readdir(BUNDLE_STORE);
    const ids = entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -5))
      .filter((id) => BUNDLE_ID_PATTERN.test(id));
    const summaries = await Promise.all(ids.map(readBundleSummary));
    return summaries.sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function getBundle(id: string): Promise<BundleSummary> {
  validateBundleId(id);
  try {
    return await readBundleSummary(id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "Bundle not found");
    throw error;
  }
}

export async function deleteBundle(id: string): Promise<void> {
  validateBundleId(id);
  try {
    await fs.unlink(storedBundlePath(id));
    await fs.unlink(storedSummaryPath(id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "Bundle not found");
    throw error;
  }
}

async function resolveMappedProfile(
  directory: unzipper.CentralDirectory,
  references: ProfileReference[],
  name: string,
  category: ProfileCategory,
): Promise<Buffer> {
  if (typeof name !== "string" || !name.trim()) throw new AppError(400, `Missing ${category} profile selector`);
  const matches = references.filter((reference) => reference.name === name);
  if (matches.length === 0) throw new AppError(400, `Unknown ${category} profile selector`);
  if (matches.length > 1) throw new AppError(400, `Ambiguous ${category} profile selector`);
  const entry = directory.files.find((file) => file.path === matches[0].path);
  if (!entry) throw new AppError(400, `Bundle is missing mapped ${category} profile`);
  const bytes = await entry.buffer();
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  } catch {
    throw new AppError(400, `Bundle has an invalid mapped ${category} JSON profile`);
  }
  return bytes;
}

async function validateBundleArchive(buffer: Buffer): Promise<BundleManifest | MaterializedBundleManifest> {
  const { directory, manifest } = await openBundleArchive(buffer);
  if (isMaterializedManifest(manifest)) {
    const entries = new Set(directory.files.map((entry) => entry.path));
    for (const category of ["printer", "process", "filament"] as const) {
      for (const reference of manifest.profiles[category]) {
        if (!entries.has(reference.path)) throw new AppError(400, `Bundle is missing mapped ${category} profile`);
      }
    }
  }
  return manifest;
}

async function openBundleArchive(buffer: Buffer): Promise<{ directory: unzipper.CentralDirectory; manifest: BundleManifest | MaterializedBundleManifest }> {
  let directory: unzipper.CentralDirectory;
  try {
    directory = await unzipper.Open.buffer(buffer);
  } catch {
    throw new AppError(400, "Bundle must be a valid ZIP archive");
  }
  if (directory.files.length === 0) throw new AppError(400, "Bundle archive is empty");
  if (directory.files.length > MAX_ARCHIVE_ENTRIES) throw new AppError(400, "Bundle has too many archive entries");

  const names = new Set<string>();
  let totalUncompressed = 0;
  for (const entry of directory.files) {
    if (!isSafeArchiveFile(entry.path, entry.type, entry.externalFileAttributes) || names.has(entry.path)) {
      throw new AppError(400, names.has(entry.path) ? "Bundle has a duplicate archive entry" : "Bundle has an unsafe archive entry");
    }
    names.add(entry.path);
    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new AppError(400, "Bundle is too large when uncompressed");
    if ((entry.uncompressedSize > 0 && entry.compressedSize === 0) || (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO)) {
      throw new AppError(400, "Bundle compression ratio is too high");
    }
  }

  const manifestEntry = directory.files.find((entry) => entry.path === "bundle_structure.json");
  if (!manifestEntry) throw new AppError(400, "Bundle is missing bundle_structure.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse((await manifestEntry.buffer()).toString("utf8"));
  } catch {
    throw new AppError(400, "Bundle has an invalid bundle_structure.json");
  }
  if (!isBundleManifest(manifest)) throw new AppError(400, "Bundle has an unsupported bundle_structure.json");
  return { directory, manifest };
}

function summaryFromManifest(manifest: BundleManifest | MaterializedBundleManifest): BundleManifest {
  const { printer_preset_name, printer, process, filament, version } = manifest;
  return version === undefined ? { printer_preset_name, printer, process, filament } : { printer_preset_name, printer, process, filament, version };
}

function isSafeArchiveFile(name: string, type: string, attributes: number): boolean {
  const unixType = (attributes >>> 16) & 0o170000;
  return type === "File" && unixType !== 0o120000 && Boolean(name) && !name.includes("\\") && !name.includes("\0") && !path.posix.isAbsolute(name) && !/^[a-zA-Z]:/.test(name) && path.posix.normalize(name) === name && !name.startsWith("../");
}

function isBundleManifest(value: unknown): value is BundleManifest | MaterializedBundleManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  const summaryValid = typeof manifest.printer_preset_name === "string" && manifest.printer_preset_name.trim().length > 0 && isStringArray(manifest.printer) && isStringArray(manifest.process) && isStringArray(manifest.filament) && (manifest.version === undefined || typeof manifest.version === "string");
  if (!summaryValid) return false;
  if (manifest.profiles === undefined) return true;
  if (!manifest.profiles || typeof manifest.profiles !== "object") return false;
  const profiles = manifest.profiles as Record<string, unknown>;
  return (["printer", "process", "filament"] as const).every((category) => isProfileReferenceArray(profiles[category], manifest[category] as string[]));
}

function isMaterializedManifest(manifest: BundleManifest | MaterializedBundleManifest): manifest is MaterializedBundleManifest {
  return "profiles" in manifest;
}

function isProfileReferenceArray(value: unknown, declaredNames: string[]): value is ProfileReference[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const names = new Set<string>();
  const paths = new Set<string>();
  return value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const reference = item as Record<string, unknown>;
    if (typeof reference.name !== "string" || !declaredNames.includes(reference.name) || typeof reference.path !== "string" || !isSafeArchivePath(reference.path) || names.has(reference.name) || paths.has(reference.path)) return false;
    names.add(reference.name);
    paths.add(reference.path);
    return true;
  });
}

function isSafeArchivePath(value: string): boolean {
  return Boolean(value) && !value.includes("\\") && !value.includes("\0") && !path.posix.isAbsolute(value) && !/^[a-zA-Z]:/.test(value) && path.posix.normalize(value) === value && !value.startsWith("../");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function validateBundleId(id: string): void {
  if (!BUNDLE_ID_PATTERN.test(id)) throw new AppError(404, "Bundle not found");
}

function storedBundlePath(id: string): string {
  validateBundleId(id);
  return path.join(BUNDLE_STORE, `${id}.bbscfg`);
}

function storedSummaryPath(id: string): string {
  validateBundleId(id);
  return path.join(BUNDLE_STORE, `${id}.json`);
}

async function readBundleSummary(id: string): Promise<BundleSummary> {
  return JSON.parse(await fs.readFile(storedSummaryPath(id), "utf8")) as BundleSummary;
}
