import archiver from "archiver";
import { execFileSync } from "child_process";
import { PassThrough } from "stream";

export type BundleManifest = {
  printer_preset_name: string;
  printer: string[];
  process: string[];
  filament: string[];
  version?: string;
};

/**
 * The repository and PrintBuddy tests contain no real Bambu .bbscfg fixture.
 * Until one is available, bundle tests deliberately support only this narrow,
 * documented manifest shape instead of inferring undocumented archive layouts.
 */
export async function makeBundleZip(
  manifest: BundleManifest | undefined,
  files: Array<{ name: string; content: string | Buffer }> = [],
): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));

  const completed = new Promise<Buffer>((resolve, reject) => {
    output.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
  });

  archive.pipe(output);
  if (manifest) {
    archive.append(JSON.stringify(manifest), { name: "bundle_structure.json" });
  }
  for (const file of files) archive.append(file.content, { name: file.name });
  await archive.finalize();
  return completed;
}

/** Uses Python's standard zipfile only where archiver sanitizes malicious names. */
export function makeRawEntryBundleZip(manifest: BundleManifest, name: string): Buffer {
  const script = [
    "import base64, json, sys, zipfile",
    "out = sys.stdout.buffer",
    "payload = json.loads(sys.stdin.read())",
    "with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:",
    "    z.writestr('bundle_structure.json', json.dumps(payload['manifest']))",
    "    z.writestr(payload['name'], '{}')",
  ].join("\n");
  return execFileSync("python3", ["-c", script], {
    input: JSON.stringify({ manifest, name }),
  });
}
