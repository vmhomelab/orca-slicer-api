import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import supertest, { type Test } from "supertest";
import type { Server } from "http";
import type TestAgent from "supertest/lib/agent";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { makeBundleZip } from "./bundle.fixture";

const sliceModel = vi.fn();
const getMetaDataFromFile = vi.fn();

vi.mock("../../src/routes/slicing/slicing.service", () => ({
  sliceModel,
  getMetaDataFromFile,
}));

vi.resetModules();
const { configureApp } = await import("../../src/index");

let server: Server;
let request: TestAgent<Test>;
const model = Buffer.from("solid test model");
const resourcesPath = path.join(process.cwd(), "tests/files/orca-resources");
process.env.ORCASLICER_RESOURCES_PATH = resourcesPath;
const bundleStore = path.join(process.env.DATA_PATH || path.join(process.cwd(), "data"), "bundles");

const mappedManifest = {
  printer_preset_name: "Printer A",
  printer: ["Printer A"],
  process: ["Process A"],
  filament: ["Filament A", "Filament B"],
  profiles: {
    printer: [{ name: "Printer A", path: "profiles/printer-a.json" }],
    process: [{ name: "Process A", path: "profiles/process-a.json" }],
    filament: [
      { name: "Filament A", path: "profiles/filament-a.json" },
      { name: "Filament B", path: "profiles/filament-b.json" },
    ],
  },
};

async function mockSliceSuccess(): Promise<void> {
  const workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "slice-resolver-"));
  const gcode = path.join(workdir, "result.gcode");
  await fs.promises.writeFile(gcode, "G1 X1");
  getMetaDataFromFile.mockResolvedValue({ printTime: 1, filamentUsedG: 2, filamentUsedMm: 3 });
  sliceModel.mockResolvedValue({ gcodes: [gcode], workdir });
}

async function uploadMappedBundle(): Promise<string> {
  const bundle = await makeBundleZip(mappedManifest, [
    { name: "profiles/printer-a.json", content: '{"name":"Printer A"}' },
    { name: "profiles/process-a.json", content: '{"name":"Process A"}' },
    { name: "profiles/filament-a.json", content: '{"name":"Filament A"}' },
    { name: "profiles/filament-b.json", content: '{"name":"Filament B"}' },
  ]);
  const id = crypto.createHash("sha256").update(bundle).digest("hex").slice(0, 16);
  await request.post("/profiles/bundle").attach("file", bundle, "mapped.bbscfg").expect(201);
  return id;
}

beforeAll(() => {
  server = configureApp().listen(0);
  request = supertest(server);
});

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(bundleStore, { recursive: true, force: true });
});

afterAll(() => server.close());

describe("synchronous profile resolver", () => {
  it("materializes only manifest-mapped bundle profiles and preserves two-filament order", async () => {
    const bundle = await uploadMappedBundle();
    await mockSliceSuccess();

    await request
      .post("/slice")
      .field("bundle", bundle)
      .field("printerName", "Printer A")
      .field("processName", "Process A")
      .field("filamentNames", "Filament B;Filament A")
      .field("bedType", "textured pei plate")
      .attach("file", model, "model.stl")
      .expect(200);

    expect(sliceModel).toHaveBeenCalledOnce();
    const [, , settings, profiles] = sliceModel.mock.calls[0];
    expect(settings.bedType).toBe("textured pei plate");
    expect(profiles.printer.toString()).toContain("Printer A");
    expect(profiles.preset.toString()).toContain("Process A");
    expect(profiles.filaments.map((profile: Buffer) => profile.toString())).toEqual([
      '{"name":"Filament B"}',
      '{"name":"Filament A"}',
    ]);
  });

  it("rejects an unknown bundle selector before calling sliceModel", async () => {
    const bundle = await uploadMappedBundle();

    await request
      .post("/slice")
      .field("bundle", bundle)
      .field("printerName", "Unknown printer")
      .field("processName", "Process A")
      .field("filamentNames", "Filament A")
      .attach("file", model, "model.stl")
      .expect(400)
      .expect((res) => expect(res.body.message).toMatch(/unknown printer/i));

    expect(sliceModel).not.toHaveBeenCalled();
  });

  it("resolves uploaded inherited profiles against bundled resources before slicing", async () => {
    await mockSliceSuccess();
    const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "../files/input/inheritance", name));

    await request
      .post("/slice")
      .attach("file", model, "model.stl")
      .attach("printerProfile", fixture("printer.json"), "printer.json")
      .attach("presetProfile", fixture("process.json"), "process.json")
      .attach("filamentProfile", fixture("filament.json"), "filament.json")
      .expect(200);

    const [, , , profiles] = sliceModel.mock.calls[0];
    expect(JSON.parse(profiles.printer.toString())).toMatchObject({
      name: "PrintBuddy P1S",
      nozzle_diameter: ["0.4"],
      bed_temperature: [70],
    });
    expect(JSON.parse(profiles.preset.toString())).toMatchObject({
      name: "PrintBuddy 0.20mm Standard",
      layer_height: "0.20",
      wall_loops: "3",
    });
    expect(JSON.parse(profiles.filaments[0].toString())).toMatchObject({
      name: "PrintBuddy PETG",
      filament_type: ["PETG"],
      filament_max_volumetric_speed: ["12"],
    });
  });

  it("passes repeated uploaded filament profiles to sliceModel in multipart order", async () => {
    await mockSliceSuccess();

    await request
      .post("/slice")
      .attach("file", model, "model.stl")
      .attach("printerProfile", Buffer.from('{"name":"Printer"}'), "printer.json")
      .attach("presetProfile", Buffer.from('{"name":"Process"}'), "process.json")
      .attach("filamentProfile", Buffer.from('{"name":"First"}'), "first.json")
      .attach("filamentProfile", Buffer.from('{"name":"Second"}'), "second.json")
      .expect(200);

    expect(sliceModel).toHaveBeenCalledOnce();
    expect(sliceModel.mock.calls[0][3].filaments.map((profile: Buffer) => profile.toString())).toEqual([
      '{"name":"First"}',
      '{"name":"Second"}',
    ]);
  });

  it("rejects invalid bed types before calling sliceModel", async () => {
    await request
      .post("/slice")
      .field("bedType", "../../unsafe")
      .attach("file", model, "model.stl")
      .expect(400)
      .expect((res) => expect(res.body.message).toMatch(/bedType/i));

    expect(sliceModel).not.toHaveBeenCalled();
  });

  it("keeps legacy name-only bundles importable but returns a clear unsliceable error", async () => {
    const legacyManifest = {
      printer_preset_name: "Printer A",
      printer: ["Printer A"],
      process: ["Process A"],
      filament: ["Filament A"],
    };
    const legacy = await makeBundleZip(legacyManifest);
    const id = crypto.createHash("sha256").update(legacy).digest("hex").slice(0, 16);
    await request.post("/profiles/bundle").attach("file", legacy, "legacy.bbscfg").expect(201);

    await request
      .post("/slice")
      .field("bundle", id)
      .field("printerName", "Printer A")
      .field("processName", "Process A")
      .field("filamentNames", "Filament A")
      .attach("file", model, "model.stl")
      .expect(400)
      .expect((res) => expect(res.body.message).toMatch(/cannot be sliced.*manifest/i));

    expect(sliceModel).not.toHaveBeenCalled();
  });
});
