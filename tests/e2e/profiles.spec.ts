import { describe, expect, it } from "vitest";
import { request } from "./setup";
import fs from "fs";
import path from "path";

describe("Profiles API", () => {
  describe("GET /profiles/bundled", () => {
    it("discovers concrete stock profiles by type in deterministic name order", async () => {
      const resourcesRoot = process.env.ORCASLICER_RESOURCES_PATH!;
      const profilesRoot = path.join(resourcesRoot, "profiles", "bundled-e2e");
      fs.mkdirSync(profilesRoot, { recursive: true });
      fs.writeFileSync(
        path.join(profilesRoot, "z-printer.json"),
        JSON.stringify({ type: "machine", name: "Zulu printer", inherits: "base-z" }),
      );
      fs.writeFileSync(
        path.join(profilesRoot, "a-printer.json"),
        JSON.stringify({ type: "machine", name: "Alpha printer", inherits: "base-a" }),
      );
      fs.writeFileSync(
        path.join(profilesRoot, "process.json"),
        JSON.stringify({ type: "process", name: "Quality process", inherits: "process-base" }),
      );
      fs.writeFileSync(
        path.join(profilesRoot, "filament.json"),
        JSON.stringify({ type: "filament", name: "PLA filament", inherits: "filament-base" }),
      );
      fs.writeFileSync(
        path.join(profilesRoot, "abstract.json"),
        JSON.stringify({ type: "filament", name: "Abstract filament", inherits: "" }),
      );
      fs.writeFileSync(path.join(profilesRoot, "invalid.json"), "not json");

      const response = await request.get("/profiles/bundled").expect(200);

      expect(response.body).toEqual({
        printer: [
          { name: "Alpha printer", base_id: "base-a" },
          { name: "Zulu printer", base_id: "base-z" },
        ],
        process: [{ name: "Quality process", base_id: "process-base" }],
        filament: [{ name: "PLA filament", base_id: "filament-base" }],
      });
    });
  });

  const printerPath = path.join(__dirname, "../files/input/printer.json");
  const printerBuffer = fs.readFileSync(printerPath);

  const presetPath = path.join(__dirname, "../files/input/process.json");
  const presetBuffer = fs.readFileSync(presetPath);

  const filamentPath = path.join(__dirname, "../files/input/filament.json");
  const filamentBuffer = fs.readFileSync(filamentPath);

  const inheritedProfiles = [
    {
      category: "printers",
      storedName: "unresolvedprinter",
      fileName: "printer.json",
      buffer: fs.readFileSync(
        path.join(__dirname, "../files/input/inheritance/printer.json"),
      ),
      inheritedField: "nozzle_diameter",
      expectedInheritedValue: ["0.4"],
      expectedOverrideField: "bed_temperature",
      expectedOverrideValue: [70],
    },
    {
      category: "presets",
      storedName: "unresolvedpreset",
      fileName: "process.json",
      buffer: fs.readFileSync(
        path.join(__dirname, "../files/input/inheritance/process.json"),
      ),
      inheritedField: "layer_height",
      expectedInheritedValue: "0.20",
      expectedOverrideField: "wall_loops",
      expectedOverrideValue: "3",
    },
    {
      category: "filaments",
      storedName: "unresolvedfilament",
      fileName: "filament.json",
      buffer: fs.readFileSync(
        path.join(__dirname, "../files/input/inheritance/filament.json"),
      ),
      inheritedField: "filament_type",
      expectedInheritedValue: ["PETG"],
      expectedOverrideField: "filament_max_volumetric_speed",
      expectedOverrideValue: ["12"],
    },
  ];

  describe("POST /profiles/:category", () => {
    it("should upload a printer profile successfully", async () => {
      await request
        .post("/profiles/printers")
        .field("name", "testprinter")
        .attach("file", printerBuffer, "printer.json")
        .expect(201)
        .expect("Content-Type", /json/)
        .expect({ name: "testprinter" });
    });

    it("should upload a preset profile successfully", async () => {
      await request
        .post("/profiles/presets")
        .field("name", "testpreset")
        .attach("file", presetBuffer, "process.json")
        .expect(201)
        .expect({ name: "testpreset" });
    });

    it("should upload a filament profile successfully", async () => {
      await request
        .post("/profiles/filaments")
        .field("name", "testfilament")
        .attach("file", filamentBuffer, "filament.json")
        .expect(201)
        .expect({ name: "testfilament" });
    });

    for (const profile of inheritedProfiles) {
      it(`stores an inherited ${profile.category} profile unchanged when resolveInheritance is omitted`, async () => {
        await request
          .post(`/profiles/${profile.category}`)
          .field("name", profile.storedName)
          .attach("file", profile.buffer, profile.fileName)
          .expect(201)
          .expect({ name: profile.storedName });

        const stored = await request
          .get(`/profiles/${profile.category}/${profile.storedName}`)
          .expect(200);
        expect(stored.body).toEqual(JSON.parse(profile.buffer.toString("utf8")));
      });

      it(`resolves inherited fields when uploading an inherited ${profile.category} profile`, async () => {
        const resolvedName = `resolved${profile.storedName}`;
        await request
          .post(`/profiles/${profile.category}`)
          .field("name", resolvedName)
          .field("resolveInheritance", "true")
          .attach("file", profile.buffer, profile.fileName)
          .expect(201)
          .expect({ name: resolvedName });

        const stored = await request
          .get(`/profiles/${profile.category}/${resolvedName}`)
          .expect(200);
        expect(stored.body[profile.inheritedField]).toEqual(
          profile.expectedInheritedValue,
        );
        expect(stored.body[profile.expectedOverrideField]).toEqual(
          profile.expectedOverrideValue,
        );
      });
    }

    it("returns a safe, meaningful error when an inherited parent cannot be found", async () => {
      const missingParent = Buffer.from(
        JSON.stringify({
          type: "machine",
          name: "Missing parent child",
          inherits: "does-not-exist",
        }),
      );

      await request
        .post("/profiles/printers")
        .field("name", "missingparent")
        .field("resolveInheritance", "true")
        .attach("file", missingParent, "printer.json")
        .expect(400)
        .expect((res) => {
          expect(res.body.message).toBe(
            'Unable to resolve inherited printers profile: parent "does-not-exist" was not found.',
          );
          expect(res.body.message).not.toContain(
            process.env.ORCASLICER_RESOURCES_PATH!,
          );
        });
    });

    it("validates an inherited profile before looking up its parent", async () => {
      const malformedProfile = Buffer.from(
        JSON.stringify({
          type: "filament",
          name: "Malformed inheritance",
          inherits: 123,
        }),
      );

      await request
        .post("/profiles/filaments")
        .field("name", "malformedinheritance")
        .field("resolveInheritance", "true")
        .attach("file", malformedProfile, "filament.json")
        .expect(400)
        .expect((res) => {
          expect(res.body.message).toBe(
            'Inherited filaments profile must include a non-empty "inherits" string.',
          );
        });
    });

    it("does not treat an inheritance value as a host path", async () => {
      const pathLikeParent = Buffer.from(
        JSON.stringify({
          type: "machine",
          name: "Path-like parent",
          inherits: "/etc/passwd",
        }),
      );

      await request
        .post("/profiles/printers")
        .field("name", "pathlikeinheritance")
        .field("resolveInheritance", "true")
        .attach("file", pathLikeParent, "printer.json")
        .expect(400)
        .expect((res) => {
          expect(res.body.message).toBe(
            'Inherited printers profile must use a valid "inherits" profile name.',
          );
          expect(res.body.message).not.toContain("/etc/passwd");
        });
    });

    it("should return 400 for invalid category", async () => {
      await request
        .post("/profiles/invalid")
        .field("name", "test")
        .attach("file", printerBuffer, "printer.json")
        .expect(400)
        .expect((res) => {
          if (res.body.message !== "Invalid or missing category")
            throw new Error("Wrong error message: " + res.body.message);
        });
    });

    it("should return 400 for invalid name (special characters)", async () => {
      await request
        .post("/profiles/printers")
        .field("name", "test-printer!")
        .attach("file", printerBuffer, "printer.json")
        .expect(400)
        .expect((res) => {
          if (res.body.message !== "Name must only contain letters and numbers")
            throw new Error("Wrong error message: " + res.body.message);
        });
    });

    it("should return 400 if file is missing", async () => {
      await request
        .post("/profiles/printers")
        .field("name", "testprinter")
        .expect(400)
        .expect((res) => {
          if (res.body.message !== "File is required")
            throw new Error("Wrong error message: " + res.body.message);
        });
    });
  });

  describe("GET /profiles/:category", () => {
    it("should list uploaded printer profiles", async () => {
      await request
        .get("/profiles/printers")
        .expect(200)
        .expect("Content-Type", /json/)
        .expect((res) => {
          if (!Array.isArray(res.body))
            throw new Error("Response should be an array");
          if (!res.body.includes("testprinter"))
            throw new Error("testprinter should be in the list");
        });
    });

    it("should list uploaded preset profiles", async () => {
      await request
        .get("/profiles/presets")
        .expect(200)
        .expect("Content-Type", /json/)
        .expect((res) => {
          if (!Array.isArray(res.body))
            throw new Error("Response should be an array");
          if (!res.body.includes("testpreset"))
            throw new Error("testpreset should be in the list");
        });
    });

    it("should list uploaded filament profiles", async () => {
      await request
        .get("/profiles/filaments")
        .expect(200)
        .expect("Content-Type", /json/)
        .expect((res) => {
          if (!Array.isArray(res.body))
            throw new Error("Response should be an array");
          if (!res.body.includes("testfilament"))
            throw new Error("testfilament should be in the list");
        });
    });
  });

  describe("GET /profiles/:category/:name", () => {
    it("should get a specific printer profile", async () => {
      await request
        .get("/profiles/printers/testprinter")
        .expect(200)
        .expect("Content-Type", /json/)
        .expect((res) => {
          if (res.body.name !== "Bambu Lab P1S 0.4 nozzle")
            throw new Error(
              `Profile content mismatch, got "${res.body.name}" expected "Bambu Lab P1S 0.4 nozzle"`
            );
        });
    });
    it("should get a specific preset profile", async () => {
      await request
        .get("/profiles/presets/testpreset")
        .expect(200)
        .expect("Content-Type", /json/)
        .expect((res) => {
          if (res.body.name !== "0.20mm Standard @BBL X1C")
            throw new Error(
              `Profile content mismatch, got "${res.body.name}" expected "0.20mm Standard @BBL X1C"`
            );
        });
    });
    it("should get a specific filament profile", async () => {
      await request
        .get("/profiles/filaments/testfilament")
        .expect(200)
        .expect("Content-Type", /json/)
        .expect((res) => {
          if (res.body.name !== "Bambu PETG Basic @BBL X1C")
            throw new Error(
              `Profile content mismatch, got "${res.body.name}" expected "Bambu PETG Basic @BBL X1C"`
            );
        });
    });

    it("should return error for non-existent printer profile", async () => {
      await request.get("/profiles/printers/nonexistent").expect(500);
    });
    it("should return error for non-existent preset profile", async () => {
      await request.get("/profiles/presets/nonexistent").expect(500);
    });
    it("should return error for non-existent filament profile", async () => {
      await request.get("/profiles/filaments/nonexistent").expect(500);
    });
  });
});
