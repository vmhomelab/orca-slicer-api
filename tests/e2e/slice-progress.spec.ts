import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import supertest, { type Test } from "supertest";
import type { Server } from "http";
import type TestAgent from "supertest/lib/agent";
import fs from "fs/promises";
import os from "os";
import path from "path";

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
const id = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeAll(() => {
  server = configureApp().listen(0);
  request = supertest(server);
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  server.close();
});

describe("synchronous slice progress", () => {
  it("returns 404 for unknown or malformed request ids", async () => {
    await request.get(`/slice/progress/${id("01")}`).expect(404);
    await request.get("/slice/progress/not-a-uuid").expect(404);
  });

  it("exposes a working snapshot while the requested slice is pending", async () => {
    const held = deferred<{ gcodes: string[]; workdir: string }>();
    sliceModel.mockReturnValueOnce(held.promise);
    const requestId = id("02");

    const sliceResponse = request
      .post("/slice")
      .field("requestId", requestId)
      .attach("file", model, "model.stl")
      .then((response) => response);

    await vi.waitFor(() => expect(sliceModel).toHaveBeenCalledOnce());

    const snapshot = await request.get(`/slice/progress/${requestId}`).expect(200);
    expect(snapshot.body).toEqual({ requestId, status: "working" });

    held.reject(new Error("/internal/slicer/path must not be exposed"));
    expect((await sliceResponse).status).toBe(500);
  });

  it("reports terminal success after the slice response completes", async () => {
    const requestId = id("03");
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "slice-progress-"));
    const gcode = path.join(workdir, "result.gcode");
    await fs.writeFile(gcode, "G1 X1");
    getMetaDataFromFile.mockResolvedValueOnce({
      printTime: 1,
      filamentUsedG: 2,
      filamentUsedMm: 3,
    });
    sliceModel.mockResolvedValueOnce({
      gcodes: [gcode],
      workdir,
    });

    await request
      .post("/slice")
      .field("requestId", requestId)
      .attach("file", model, "model.stl")
      .expect(200);

    const snapshot = await request.get(`/slice/progress/${requestId}`).expect(200);
    expect(snapshot.body).toEqual({ requestId, status: "succeeded" });
  });

  it("reports a safe terminal failure when slicing fails", async () => {
    const requestId = id("04");
    sliceModel.mockRejectedValueOnce(new Error("/internal/slicer/path failed"));

    await request
      .post("/slice")
      .field("requestId", requestId)
      .attach("file", model, "model.stl")
      .expect(500);

    const snapshot = await request.get(`/slice/progress/${requestId}`).expect(200);
    expect(snapshot.body).toEqual({ requestId, status: "failed" });
    expect(JSON.stringify(snapshot.body)).not.toContain("/internal");
  });

  it("rejects duplicate live request ids before slicing", async () => {
    const held = deferred<{ gcodes: string[]; workdir: string }>();
    sliceModel.mockReturnValueOnce(held.promise);
    const requestId = id("05");
    const firstResponse = request
      .post("/slice")
      .field("requestId", requestId)
      .attach("file", model, "model.stl")
      .then((response) => response);

    await vi.waitFor(() => expect(sliceModel).toHaveBeenCalledOnce());

    await request
      .post("/slice")
      .field("requestId", requestId)
      .attach("file", model, "model.stl")
      .expect(409);
    expect(sliceModel).toHaveBeenCalledOnce();

    held.reject(new Error("slice stopped"));
    expect((await firstResponse).status).toBe(500);
  });

  it("rejects malformed request ids before slicing", async () => {
    await request
      .post("/slice")
      .field("requestId", "not-a-uuid")
      .attach("file", model, "model.stl")
      .expect(400);
  });
});
