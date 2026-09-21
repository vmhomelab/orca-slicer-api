import crypto from "crypto";
import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { request } from "./setup";
import { makeBundleZip, makeRawEntryBundleZip, type BundleManifest } from "./bundle.fixture";

const manifest: BundleManifest = {
  printer_preset_name: "# Bambu Lab H2D 0.4 nozzle",
  printer: ["# Bambu Lab H2D 0.4 nozzle"],
  process: ["# 0.20mm Standard @BBL H2D"],
  filament: ["# Bambu PLA Basic @BBL H2D"],
  version: "02.06.00.50",
};

const bundleStore = path.join(process.env.DATA_PATH || path.join(process.cwd(), "data"), "bundles");

beforeEach(() => fs.rmSync(bundleStore, { recursive: true, force: true }));

describe("Profile bundle API", () => {
  it("stores a valid narrow bundle manifest and supports idempotent CRUD", async () => {
    const bundle = await makeBundleZip(manifest, [
      { name: "presets/printer.json", content: "{}" },
    ]);
    const id = crypto.createHash("sha256").update(bundle).digest("hex").slice(0, 16);
    const expected = { id, ...manifest };

    await request
      .post("/profiles/bundle")
      .attach("file", bundle, "h2d.bbscfg")
      .expect(201)
      .expect(expected);
    await request
      .post("/profiles/bundle")
      .attach("file", bundle, "h2d.bbscfg")
      .expect(200)
      .expect(expected);
    await request.get("/profiles/bundles").expect(200).expect([expected]);
    await request.get(`/profiles/bundles/${id}`).expect(200).expect(expected);
    await request.delete(`/profiles/bundles/${id}`).expect(204);
    await request.get(`/profiles/bundles/${id}`).expect(404);
    await request.delete(`/profiles/bundles/${id}`).expect(404);
  });

  it("rejects invalid or unsafe archives with clear JSON 400 errors", async () => {
    const missingManifest = await makeBundleZip(undefined, [{ name: "preset.json", content: "{}" }]);
    await request
      .post("/profiles/bundle")
      .attach("file", missingManifest, "missing.bbscfg")
      .expect(400)
      .expect((res) => expect(res.body.message).toMatch(/bundle_structure\.json/));

    // `archiver` normalizes ../ names, so emit a raw central-directory name
    // to exercise the same traversal input an attacker can upload.
    const traversal = makeRawEntryBundleZip(manifest, "../escape.json");
    await request
      .post("/profiles/bundle")
      .attach("file", traversal, "traversal.bbscfg")
      .expect(400)
      .expect((res) => expect(res.body.message).toMatch(/unsafe archive entry/));

    const duplicate = await makeBundleZip(manifest, [{ name: "preset.json", content: "{}" }]);
    const duplicateWithManifest = await makeBundleZip(undefined, [
      { name: "bundle_structure.json", content: JSON.stringify(manifest) },
      { name: "bundle_structure.json", content: JSON.stringify(manifest) },
    ]);
    expect(duplicate.length).toBeGreaterThan(0);
    await request
      .post("/profiles/bundle")
      .attach("file", duplicateWithManifest, "duplicate.bbscfg")
      .expect(400)
      .expect((res) => expect(res.body.message).toMatch(/duplicate archive entry/));

    await request
      .post("/profiles/bundle")
      .attach("file", Buffer.from("not a zip"), "invalid.bbscfg")
      .expect(400)
      .expect((res) => expect(res.body.message).toMatch(/valid ZIP/));
  });
});
