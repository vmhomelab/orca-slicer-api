import { promises as fs } from "fs";
import path from "path";
import { AppError } from "../../middleware/error";
import type { Category } from "../slicing/models";

type Profile = Record<string, unknown>;

const profileTypes: Record<Category, string> = {
  printers: "machine",
  presets: "process",
  filaments: "filament",
};

/**
 * Resolves an uploaded Orca/Bambu profile against the system profile resources.
 * Parent names are always looked up from the resource index; they are never used
 * as filesystem paths.
 */
export async function resolveProfileInheritance(
  category: Category,
  content: Buffer,
): Promise<Profile> {
  const profile = parseProfile(category, content);
  const inherits = validateInheritedProfile(category, profile);
  const profiles = await loadProfiles(category);

  if (!profiles.has(inherits)) {
    throw new AppError(
      400,
      `Unable to resolve inherited ${category} profile: parent "${inherits}" was not found.`,
    );
  }

  return resolveProfile(profile, profiles, category, new Set<string>());
}

function parseProfile(category: Category, content: Buffer): Profile {
  try {
    const parsed: unknown = JSON.parse(content.toString("utf8"));
    if (!isProfile(parsed)) {
      throw new Error("Profile must be an object");
    }
    return parsed;
  } catch {
    throw new AppError(400, `Invalid inherited ${category} profile JSON.`);
  }
}

function validateInheritedProfile(category: Category, profile: Profile): string {
  const inherits = profile.inherits;
  if (typeof inherits !== "string" || inherits.trim().length === 0) {
    throw new AppError(
      400,
      `Inherited ${category} profile must include a non-empty "inherits" string.`,
    );
  }
  if (inherits.includes("/") || inherits.includes("\\") || inherits.includes("\0")) {
    throw new AppError(
      400,
      `Inherited ${category} profile must use a valid "inherits" profile name.`,
    );
  }
  return inherits;
}

async function loadProfiles(category: Category): Promise<Map<string, Profile>> {
  const resourcesPath = process.env.ORCASLICER_RESOURCES_PATH;
  if (!resourcesPath) {
    throw new AppError(500, "Profile inheritance resolution is not configured.");
  }

  const profilesRoot = path.resolve(resourcesPath, "profiles");
  let files: string[];
  try {
    files = await findJsonFiles(profilesRoot);
  } catch {
    throw new AppError(500, "Profile inheritance resources are unavailable.");
  }

  const profiles = new Map<string, Profile>();
  for (const file of files) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (
        isProfile(parsed) &&
        parsed.type === profileTypes[category] &&
        typeof parsed.name === "string" &&
        parsed.name.trim().length > 0
      ) {
        profiles.set(parsed.name, parsed);
      }
    } catch {
      // A malformed unrelated system profile must not prevent valid parents
      // elsewhere in Orca's resource tree from being resolved.
    }
  }
  return profiles;
}

async function findJsonFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return findJsonFiles(entryPath);
      if (entry.isFile() && entry.name.endsWith(".json")) return [entryPath];
      return [];
    }),
  );
  return nested.flat();
}

function resolveProfile(
  profile: Profile,
  profiles: Map<string, Profile>,
  category: Category,
  ancestors: Set<string>,
): Profile {
  const inherits = validateInheritedProfile(category, profile);
  if (ancestors.has(inherits)) {
    throw new AppError(400, `Unable to resolve inherited ${category} profile: inheritance cycle detected.`);
  }

  const parent = profiles.get(inherits);
  if (!parent) {
    throw new AppError(
      400,
      `Unable to resolve inherited ${category} profile: parent "${inherits}" was not found.`,
    );
  }

  const parentInherits = parent.inherits;
  if (parentInherits === undefined) return { ...parent, ...profile };
  if (typeof parentInherits !== "string" || parentInherits.trim().length === 0) {
    throw new AppError(500, "Profile inheritance resources contain an invalid parent profile.");
  }

  const nextAncestors = new Set(ancestors).add(inherits);
  return {
    ...resolveProfile(parent, profiles, category, nextAncestors),
    ...profile,
  };
}

function isProfile(value: unknown): value is Profile {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
