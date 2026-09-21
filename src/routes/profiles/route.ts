import { Router } from "express";
import { promises as fs } from "fs";
import path from "path";
import { uploadBundle, uploadJson } from "../../middleware/upload";
import type { Category } from "../slicing/models";
import {
  saveSetting,
  listSettings,
  getSetting,
  deleteSetting,
} from "./settings.service";
import { AppError } from "../../middleware/error";
import { resolveProfileInheritance } from "./inheritance.service";
import { deleteBundle, getBundle, listBundles, saveBundle } from "./bundle.service";

const router = Router();

type BundledProfile = {
  name: string;
  base_id: string;
  compatible_printers?: string[];
};
type BundledProfiles = {
  printer: BundledProfile[];
  process: BundledProfile[];
  filament: BundledProfile[];
};

router.get("/bundled", async (_req, res) => {
  res.status(200).json(await listBundledProfiles());
});

// Literal bundle routes must remain before /:category.
router.post("/bundle", uploadBundle.single("file"), async (req, res) => {
  if (!req.file) throw new AppError(400, "Bundle file is required");
  const { summary, created } = await saveBundle(req.file.buffer);
  res.status(created ? 201 : 200).json(summary);
});
router.get("/bundles", async (_req, res) => {
  res.status(200).json(await listBundles());
});
router.get("/bundles/:id", async (req, res) => {
  res.status(200).json(await getBundle(req.params.id));
});
router.delete("/bundles/:id", async (req, res) => {
  await deleteBundle(req.params.id);
  res.status(204).send();
});

router.post("/:category", uploadJson.single("file"), async (req, res) => {
  const { name, resolveInheritance } = req.body;

  validateName(name);

  if (!req.file) {
    throw new AppError(400, "File is required");
  }

  validateCategory(req.params.category as string);

  const category = req.params.category as Category;
  const content =
    resolveInheritance === "true"
      ? await resolveProfileInheritance(category, req.file.buffer)
      : JSON.parse(req.file.buffer.toString("utf8"));
  await saveSetting(category, name, content);
  res.status(201).json({ name });
});

router.get("/:category", async (req, res) => {
  validateCategory(req.params.category);

  const settings = await listSettings(req.params.category as Category);
  res.status(200).json(settings);
});

router.get("/:category/:name", async (req, res) => {
  validateCategory(req.params.category);
  validateName(req.params.name);

  const setting = await getSetting(
    req.params.category as Category,
    req.params.name,
  );
  res.status(200).json(setting);
});

router.delete("/:category/:name", async (req, res) => {
  validateCategory(req.params.category);
  validateName(req.params.name);

  await deleteSetting(req.params.category as Category, req.params.name);
  res.status(204).send();
});

function validateCategory(category: string) {
  if (!category || !["printers", "presets", "filaments"].includes(category)) {
    throw new AppError(400, "Invalid or missing category");
  }
}

function validateName(name: string) {
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new AppError(400, "Name cannot be empty");
  }
  if (!/^[a-zA-Z0-9]+$/.test(name)) {
    throw new AppError(400, "Name must only contain letters and numbers");
  }
}

async function listBundledProfiles(): Promise<BundledProfiles> {
  const profilesRoot = path.join(
    process.env.ORCASLICER_RESOURCES_PATH || "",
    "profiles",
  );
  const result: BundledProfiles = { printer: [], process: [], filament: [] };

  try {
    const entries = await fs.readdir(profilesRoot, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filename = path.join(entry.parentPath, entry.name);
      try {
        const profile: unknown = JSON.parse(await fs.readFile(filename, "utf8"));
        if (!isConcreteBundledProfile(profile)) continue;
        const category = bundledCategory(profile.type);
        if (category) {
          const compatible_printers =
            category === "printer" ? undefined : compatiblePrinters(profile.compatible_printers);
          result[category].push({ name: profile.name, base_id: profile.inherits, compatible_printers });
        }
      } catch {
        // Resource trees can contain invalid JSON; expose only usable stock presets.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  for (const profiles of Object.values(result)) {
    profiles.sort((a, b) => a.name.localeCompare(b.name));
  }
  return result;
}

function isConcreteBundledProfile(
  profile: unknown,
): profile is { type: string; name: string; inherits: string; compatible_printers?: unknown } {
  if (!profile || typeof profile !== "object") return false;
  const candidate = profile as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.trim().length > 0 &&
    typeof candidate.inherits === "string" &&
    candidate.inherits.trim().length > 0 &&
    typeof candidate.type === "string"
  );
}

function compatiblePrinters(value: unknown): string[] | undefined {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const names = values.filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  return names.length > 0 ? names : undefined;
}

function bundledCategory(type: string): keyof BundledProfiles | undefined {
  if (type === "machine") return "printer";
  if (type === "process") return "process";
  if (type === "filament") return "filament";
  return undefined;
}

export default router;
