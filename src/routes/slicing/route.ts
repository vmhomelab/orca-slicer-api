import { Router } from "express";
import { uploadFullPrint } from "../../middleware/upload";
import { AppError } from "../../middleware/error";
import type {
  SliceMetaData,
  SlicingSettings,
  UploadedProfiles,
} from "./models";
import { getMetaDataFromFile, sliceModel } from "./slicing.service";
import fs from "fs/promises";
import path from "path";
import archiver from "archiver";
import { generateMetaDataHeaders } from "./helpers";
import { resolveBundleProfiles } from "../profiles/bundle.service";
import { resolveProfileInheritance } from "../profiles/inheritance.service";

const router = Router();
const BED_TYPES = new Set([
  "cool plate",
  "pc plate",
  "cool plate (supertack)",
  "supertack plate",
  "bambu cool plate supertack",
  "engineering plate",
  "high temp plate",
  "textured pei plate",
  "pei plate",
  "smooth pei plate",
]);

type SliceProgressStatus = "working" | "succeeded" | "failed";

interface SliceProgressRecord {
  requestId: string;
  status: SliceProgressStatus;
  expiresAt: number;
}

const DEFAULT_PROGRESS_TTL_MS = 15 * 60 * 1000;
const DEFAULT_PROGRESS_MAX_RECORDS = 100;
const progressTtlMs = boundedNumber(
  process.env.SLICE_PROGRESS_TTL_MS,
  DEFAULT_PROGRESS_TTL_MS,
  1000,
  24 * 60 * 60 * 1000,
);
const progressMaxRecords = boundedNumber(
  process.env.SLICE_PROGRESS_MAX_RECORDS,
  DEFAULT_PROGRESS_MAX_RECORDS,
  1,
  1000,
);
const progressRecords = new Map<string, SliceProgressRecord>();

function boundedNumber(
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function removeExpiredProgressRecords() {
  const now = Date.now();
  for (const [requestId, record] of progressRecords) {
    if (record.expiresAt <= now) progressRecords.delete(requestId);
  }
}

function createProgressRecord(requestId: string): void {
  removeExpiredProgressRecords();
  if (progressRecords.has(requestId)) {
    throw new AppError(409, "A slice request with this requestId is already active");
  }

  while (progressRecords.size >= progressMaxRecords) {
    const terminal = [...progressRecords.values()].find(
      (record) => record.status !== "working",
    );
    if (!terminal) {
      throw new AppError(503, "Slice progress tracking is at capacity");
    }
    progressRecords.delete(terminal.requestId);
  }

  progressRecords.set(requestId, {
    requestId,
    status: "working",
    expiresAt: Date.now() + progressTtlMs,
  });
}

function markProgressTerminal(requestId: string, status: "succeeded" | "failed") {
  const record = progressRecords.get(requestId);
  if (record) record.status = status;
}

/**
 * Returns a deliberately small, safe snapshot for synchronous /slice requests.
 * Progress percentages are omitted because Orca's CLI does not provide a reliable
 * machine-readable percentage for this synchronous invocation.
 */
router.get("/progress/:requestId", (req, res) => {
  if (!isUuid(req.params.requestId)) {
    throw new AppError(404, "Slice request not found");
  }

  removeExpiredProgressRecords();
  const record = progressRecords.get(req.params.requestId);
  if (!record) {
    throw new AppError(404, "Slice request not found");
  }

  res.status(200).json({
    requestId: record.requestId,
    status: record.status,
  });
});

router.post(
  "/",
  uploadFullPrint.fields([
    { name: "file", maxCount: 1 },
    { name: "printerProfile", maxCount: 1 },
    { name: "presetProfile", maxCount: 1 },
    { name: "filamentProfile", maxCount: 16 },
  ]),
  async (req, res) => {
    if (!req.files || Array.isArray(req.files)) {
      throw new AppError(
        400,
        "Invalid file upload format: files must be uploaded as named fields",
      );
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] };

    if (!files["file"]) {
      throw new AppError(400, "Model file is required for slicing");
    }

    const modelFile = files["file"][0];
    const settings = req.body as SlicingSettings;
    validateBedType(settings.bedType);
    const tempProfiles = await resolveUploadedProfileInheritance(
      await selectProfiles(req.body, files),
    );
    validateProfileCompatibility(tempProfiles);

    const requestId = req.body.requestId;
    if (requestId !== undefined && !isUuid(requestId)) {
      throw new AppError(400, "requestId must be a UUID");
    }

    if (requestId) createProgressRecord(requestId);

    try {
      const { gcodes, workdir } = await sliceModel(
        modelFile.buffer,
        modelFile.originalname,
        settings,
        tempProfiles,
      );

      if (gcodes.length === 1) {
        try {
          const metadata = await getMetaDataFromFile(gcodes[0]);
          res.set(generateMetaDataHeaders(metadata));
          if (requestId) markProgressTerminal(requestId, "succeeded");

          res.download(gcodes[0]);
        } finally {
          await fs.rm(workdir, { recursive: true, force: true });
        }
      } else if (gcodes.length > 1) {
        const metadata: SliceMetaData = {
          printTime: 0,
          filamentUsedG: 0,
          filamentUsedMm: 0,
        };

        for (const filePath of gcodes) {
          if (!filePath.endsWith(".gcode")) continue;

          const fileMetadata = await getMetaDataFromFile(filePath);
          metadata.printTime += fileMetadata.printTime;
          metadata.filamentUsedG += fileMetadata.filamentUsedG;
          metadata.filamentUsedMm += fileMetadata.filamentUsedMm;
        }

        res.set(generateMetaDataHeaders(metadata));

        res.attachment("result.zip");
        const archive = archiver("zip", { zlib: { level: 9 } });

        archive.on("error", (err) => {
          throw new AppError(500, `Error creating archive: ${err.message}`);
        });

        res.on("finish", async () => {
          await fs.rm(workdir, { recursive: true, force: true });
        });

        archive.pipe(res);
        gcodes.forEach((filePath) => {
          archive.file(filePath, { name: path.basename(filePath) });
        });

        if (requestId) markProgressTerminal(requestId, "succeeded");
        await archive.finalize();
      } else {
        throw new AppError(500, "No files generated during slicing");
      }

      if (requestId) markProgressTerminal(requestId, "succeeded");
    } catch (error) {
      if (requestId) markProgressTerminal(requestId, "failed");
      throw error;
    }
  },
);

function validateProfileCompatibility(profiles: UploadedProfiles): void {
  const printer = profileName(profiles.printer, "printer");
  if (!printer) return;
  assertCompatibleWithPrinter(profiles.preset, "Process", printer);
  for (const filament of profiles.filaments || []) {
    assertCompatibleWithPrinter(filament, "Filament", printer);
  }
}

function assertCompatibleWithPrinter(
  content: Buffer | undefined,
  profileKind: "Process" | "Filament",
  printer: string,
): void {
  if (!content) return;
  const profile = parseProfile(content, profileKind.toLowerCase());
  const compatible = profile.compatible_printers;
  if (!Array.isArray(compatible) || compatible.length === 0) return;
  const names = compatible.filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  if (names.length > 0 && !names.some((candidate) => samePrinterPreset(candidate, printer))) {
    const name = typeof profile.name === "string" && profile.name.trim() ? profile.name : "selected profile";
    throw new AppError(400, `${profileKind} profile "${name}" is not compatible with printer "${printer}".`);
  }
}

function canonicalPrinterPresetName(name: string): string {
  const stripped = name.replace(/^#\s*/, '').trim();
  const clone = stripped.match(/^(Bambu Lab .+?\s+\d(?:\.\d+)?\s+nozzle)\s+-\s+.+$/i);
  return clone ? clone[1] : stripped;
}

function samePrinterPreset(left: string, right: string): boolean {
  return canonicalPrinterPresetName(left) === canonicalPrinterPresetName(right);
}

function profileName(content: Buffer | undefined, kind: string): string | undefined {
  if (!content) return undefined;
  const profile = parseProfile(content, kind);
  return typeof profile.name === "string" && profile.name.trim() ? profile.name : undefined;
}

function parseProfile(content: Buffer, kind: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError(400, `Invalid ${kind} profile JSON.`);
  }
}

function validateBedType(bedType: unknown): void {
  if (bedType === undefined) return;
  if (typeof bedType !== "string" || !BED_TYPES.has(bedType.trim().toLowerCase())) {
    throw new AppError(400, "Invalid bedType");
  }
}

/** Flatten only profiles that explicitly declare a parent. This is required
 * for PrintBuddy's standard-tier `{ inherits: <bundled-name> }` stubs; it
 * also handles imported user profiles without allowing any request value to
 * become a filesystem path (the inheritance service indexes resources).
 */
async function resolveUploadedProfileInheritance(profiles: UploadedProfiles): Promise<UploadedProfiles> {
  return {
    printer: await resolveInheritedBuffer("printers", profiles.printer),
    preset: await resolveInheritedBuffer("presets", profiles.preset),
    filaments: await Promise.all(
      (profiles.filaments || []).map((profile) => resolveInheritedFilament(profile)),
    ),
  };
}

async function resolveInheritedBuffer(
  category: "printers" | "presets" | "filaments",
  content: Buffer | undefined,
): Promise<Buffer | undefined> {
  if (!content || !hasInheritance(content)) return content;
  const resolved = await resolveProfileInheritance(category, content);
  return Buffer.from(JSON.stringify(resolved));
}

async function resolveInheritedFilament(content: Buffer): Promise<Buffer> {
  return (await resolveInheritedBuffer("filaments", content)) || content;
}

function hasInheritance(content: Buffer): boolean {
  try {
    const parsed: unknown = JSON.parse(content.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const inherits = (parsed as Record<string, unknown>).inherits;
    return typeof inherits === "string" && inherits.trim().length > 0;
  } catch {
    return false;
  }
}

async function selectProfiles(
  body: Record<string, unknown>,
  files: { [fieldname: string]: Express.Multer.File[] },
): Promise<UploadedProfiles> {
  const uploaded = {
    printer: files["printerProfile"]?.[0]?.buffer,
    preset: files["presetProfile"]?.[0]?.buffer,
    filaments: files["filamentProfile"]?.map((file) => file.buffer),
  };
  const bundle = body.bundle;
  if (bundle === undefined) return uploaded;
  if (typeof bundle !== "string" || !bundle) throw new AppError(400, "Invalid bundle selector");
  if (uploaded.printer || uploaded.preset || uploaded.filaments?.length) {
    throw new AppError(400, "Bundle selectors cannot be combined with uploaded profiles");
  }
  const printerName = requiredSelector(body.printerName, "printerName");
  const processName = requiredSelector(body.processName, "processName");
  const filamentNames = requiredSelector(body.filamentNames, "filamentNames")
    .split(";")
    .map((name) => name.trim());
  if (filamentNames.some((name) => !name)) throw new AppError(400, "filamentNames must not contain empty selectors");
  return resolveBundleProfiles(bundle, printerName, processName, filamentNames);
}

function requiredSelector(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AppError(400, `${field} is required for bundle slicing`);
  return value.trim();
}

export default router;
