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

/** System profiles of one category, indexed per vendor directory. */
interface ProfileIndex {
  /** vendor directory name -> profile name -> profile */
  byVendor: Map<string, Map<string, Profile>>;
  /** profile name -> vendors that define it, in a deterministic order */
  vendorsByName: Map<string, string[]>;
}

/**
 * Vendors preferred when an uploaded profile names a parent that several
 * vendors define. Bambu Lab first (BambuStudio: "BBL", test fixtures:
 * "BambuLab"), then OrcaSlicer's shared filament library.
 */
const PREFERRED_VENDORS = ["BBL", "BambuLab", "OrcaFilamentLibrary"];

/**
 * Resolves an uploaded Orca/Bambu profile against the system profile resources.
 * Parent names are always looked up from the resource index; they are never used
 * as filesystem paths.
 *
 * Every vendor directory ships its own abstract base profiles under the same
 * names (`fdm_filament_common`, `fdm_process_common`, ...) with different
 * values, e.g. a 2.85 mm filament diameter for one vendor. Parents are
 * therefore resolved inside the vendor that owns the child profile, falling
 * back to the preferred shared vendors and then to a unique definition.
 */
export async function resolveProfileInheritance(
  category: Category,
  content: Buffer,
): Promise<Profile> {
  const profile = parseProfile(category, content);
  const inherits = validateInheritedProfile(category, profile);
  const index = await loadProfiles(category);

  if (!index.vendorsByName.has(inherits)) {
    throw new AppError(
      400,
      `Unable to resolve inherited ${category} profile: parent "${inherits}" was not found.`,
    );
  }

  const resolved = resolveProfile(profile, undefined, index, category, new Set<string>());
  return category === "filaments" ? withFilamentLiftOverrides(resolved) : resolved;
}

/**
 * OrcaSlicer filament overrides that its GUI fills with "nil" (= use the
 * printer value) when a system preset does not define them. Bambu Lab's own
 * filament chains do not, and the OrcaSlicer CLI segfaults when they are
 * absent from a loaded filament. Bambu Studio ignores them.
 */
const FILAMENT_LIFT_OVERRIDE_KEYS = [
  "filament_retract_lift_above",
  "filament_retract_lift_below",
  "filament_retract_lift_enforce",
];

function withFilamentLiftOverrides(profile: Profile): Profile {
  const result = { ...profile };
  for (const key of FILAMENT_LIFT_OVERRIDE_KEYS) {
    if (result[key] === undefined) result[key] = ["nil"];
  }
  return result;
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

async function loadProfiles(category: Category): Promise<ProfileIndex> {
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
  files.sort();

  const byVendor = new Map<string, Map<string, Profile>>();
  const vendorsByName = new Map<string, string[]>();
  for (const file of files) {
    const relative = path.relative(profilesRoot, file).split(path.sep);
    // Vendor index files (profiles/<Vendor>.json) are not profiles.
    if (relative.length < 2) continue;
    const vendor = relative[0];
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (
        isProfile(parsed) &&
        parsed.type === profileTypes[category] &&
        typeof parsed.name === "string" &&
        parsed.name.trim().length > 0
      ) {
        let vendorProfiles = byVendor.get(vendor);
        if (!vendorProfiles) {
          vendorProfiles = new Map<string, Profile>();
          byVendor.set(vendor, vendorProfiles);
        }
        if (vendorProfiles.has(parsed.name)) continue;
        vendorProfiles.set(parsed.name, parsed);
        const vendors = vendorsByName.get(parsed.name) ?? [];
        vendors.push(vendor);
        vendorsByName.set(parsed.name, vendors);
      }
    } catch {
      // A malformed unrelated system profile must not prevent valid parents
      // elsewhere in Orca's resource tree from being resolved.
    }
  }
  return { byVendor, vendorsByName };
}

/**
 * Pick the vendor whose definition of `name` should be used: the child's own
 * vendor, then the preferred shared vendors, then a vendor that is the only
 * one defining the name, then the first vendor in sorted order.
 */
function selectVendor(name: string, childVendor: string | undefined, index: ProfileIndex): string | undefined {
  const vendors = index.vendorsByName.get(name);
  if (!vendors || vendors.length === 0) return undefined;
  if (childVendor && vendors.includes(childVendor)) return childVendor;
  for (const preferred of PREFERRED_VENDORS) {
    if (vendors.includes(preferred)) return preferred;
  }
  return vendors[0];
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
  vendor: string | undefined,
  index: ProfileIndex,
  category: Category,
  ancestors: Set<string>,
): Profile {
  const inherits = validateInheritedProfile(category, profile);
  if (ancestors.has(inherits)) {
    throw new AppError(400, `Unable to resolve inherited ${category} profile: inheritance cycle detected.`);
  }

  const parentVendor = selectVendor(inherits, vendor, index);
  const parent = parentVendor ? index.byVendor.get(parentVendor)?.get(inherits) : undefined;
  if (!parentVendor || !parent) {
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
    ...resolveProfile(parent, parentVendor, index, category, nextAncestors),
    ...profile,
  };
}

function isProfile(value: unknown): value is Profile {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
