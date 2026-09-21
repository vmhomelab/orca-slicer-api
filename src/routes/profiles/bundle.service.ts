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

/**
 * Deliberately narrow temporary .bbscfg manifest support: this repository and
 * PrintBuddy contain no genuine Bambu bundle fixture. We accept only a root
 * bundle_structure.json object with printer_preset_name, printer, process,
 * filament, and optional version. No archive entry is extracted or used as a
 * filesystem path; the original ZIP is stored under its validated content id.
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
  const summary: BundleSummary = { id, ...manifest };
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

async function validateBundleArchive(buffer: Buffer): Promise<BundleManifest> {
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
    if (entry.uncompressedSize > 0 && entry.compressedSize === 0 || entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO) {
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
  return manifest;
}

function isSafeArchiveFile(name: string, type: string, attributes: number): boolean {
  const unixType = (attributes >>> 16) & 0o170000;
  return type === "File" && unixType !== 0o120000 && Boolean(name) && !name.includes("\\") && !name.includes("\0") && !path.posix.isAbsolute(name) && !/^[a-zA-Z]:/.test(name) && path.posix.normalize(name) === name && !name.startsWith("../");
}

function isBundleManifest(value: unknown): value is BundleManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  return typeof manifest.printer_preset_name === "string" && manifest.printer_preset_name.trim().length > 0 && isStringArray(manifest.printer) && isStringArray(manifest.process) && isStringArray(manifest.filament) && (manifest.version === undefined || typeof manifest.version === "string");
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
