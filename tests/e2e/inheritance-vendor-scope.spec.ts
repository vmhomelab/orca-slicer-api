import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveProfileInheritance } from "../../src/routes/profiles/inheritance.service";

// Every slicer vendor directory ships its own abstract base profiles under
// identical names (e.g. `fdm_filament_common`) with different values. The
// resolver must stay inside the vendor that owns the selected profile instead
// of using whichever same-named base was indexed last.

let resourcesRoot: string;
const originalResources = process.env.ORCASLICER_RESOURCES_PATH;

function writeProfile(vendor: string, file: string, profile: object): void {
  const dir = path.join(resourcesRoot, "profiles", vendor, "filament");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(profile));
}

beforeAll(() => {
  resourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-scope-"));
  // Vendor index file at the profiles root must be ignored.
  fs.mkdirSync(path.join(resourcesRoot, "profiles"), { recursive: true });
  fs.writeFileSync(path.join(resourcesRoot, "profiles", "BBL.json"), JSON.stringify({ name: "BBL" }));

  writeProfile("BBL", "fdm_filament_common.json", {
    type: "filament",
    name: "fdm_filament_common",
    filament_diameter: ["1.75"],
  });
  writeProfile("BBL", "Vendor PLA @base.json", {
    type: "filament",
    name: "Vendor PLA @base",
    inherits: "fdm_filament_common",
    filament_type: ["PLA"],
  });
  writeProfile("BBL", "Vendor PLA @BBL X2D 0.4 nozzle.json", {
    type: "filament",
    name: "Vendor PLA @BBL X2D 0.4 nozzle",
    inherits: "Vendor PLA @base",
    nozzle_temperature: ["220"],
  });
  // Sorted after BBL, so a name-only, last-wins index would pick this one.
  writeProfile("Voxelab", "fdm_filament_common.json", {
    type: "filament",
    name: "fdm_filament_common",
    filament_diameter: ["2.85"],
  });
  writeProfile("Voxelab", "Voxelab PLA.json", {
    type: "filament",
    name: "Voxelab PLA",
    inherits: "fdm_filament_common",
  });
  process.env.ORCASLICER_RESOURCES_PATH = resourcesRoot;
});

afterAll(() => {
  process.env.ORCASLICER_RESOURCES_PATH = originalResources;
  fs.rmSync(resourcesRoot, { recursive: true, force: true });
});

function stub(name: string): Buffer {
  return Buffer.from(JSON.stringify({ name, inherits: name, from: "system", type: "filament" }));
}

describe("vendor-scoped profile inheritance", () => {
  it("resolves shared base names within the vendor of the selected profile", async () => {
    const resolved = await resolveProfileInheritance("filaments", stub("Vendor PLA @BBL X2D 0.4 nozzle"));

    expect(resolved).toMatchObject({
      name: "Vendor PLA @BBL X2D 0.4 nozzle",
      filament_type: ["PLA"],
      nozzle_temperature: ["220"],
      filament_diameter: ["1.75"],
    });
  });

  it("keeps another vendor's chain on that vendor's base profile", async () => {
    const resolved = await resolveProfileInheritance("filaments", stub("Voxelab PLA"));

    expect(resolved).toMatchObject({ name: "Voxelab PLA", filament_diameter: ["2.85"] });
  });

  it("prefers the Bambu vendor when an uploaded profile names an ambiguous base", async () => {
    const resolved = await resolveProfileInheritance("filaments", stub("fdm_filament_common"));

    expect(resolved).toMatchObject({ filament_diameter: ["1.75"] });
  });
  it("fills OrcaSlicer filament lift overrides with nil only when they are missing", async () => {
    const resolved = await resolveProfileInheritance("filaments", stub("Vendor PLA @BBL X2D 0.4 nozzle"));

    expect(resolved).toMatchObject({
      filament_retract_lift_above: ["nil"],
      filament_retract_lift_below: ["nil"],
      filament_retract_lift_enforce: ["nil"],
    });

    const explicit = await resolveProfileInheritance(
      "filaments",
      Buffer.from(
        JSON.stringify({
          name: "Custom PLA",
          inherits: "Vendor PLA @BBL X2D 0.4 nozzle",
          type: "filament",
          filament_retract_lift_above: ["1"],
        }),
      ),
    );
    expect(explicit).toMatchObject({
      filament_retract_lift_above: ["1"],
      filament_retract_lift_below: ["nil"],
    });
  });
});
