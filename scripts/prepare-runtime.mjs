import { build } from "esbuild";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { t as readTar } from "tar";
import yauzl from "yauzl";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "apps/desktop/src-tauri/runtime");
const release =
  process.argv.includes("--release") ||
  process.env.UIGREP_RUNTIME_RELEASE === "1";
const targetIndex = process.argv.indexOf("--target");
const target =
  targetIndex < 0
    ? process.env.TAURI_ENV_TARGET_TRIPLE
    : process.argv[targetIndex + 1];
const targets = {
  "x86_64-pc-windows-msvc": ["win32", "x64"],
  "aarch64-pc-windows-msvc": ["win32", "arm64"],
  "x86_64-apple-darwin": ["darwin", "x64"],
  "aarch64-apple-darwin": ["darwin", "arm64"],
  "x86_64-unknown-linux-gnu": ["linux", "x64"],
  "aarch64-unknown-linux-gnu": ["linux", "arm64"],
};
if (target && !Object.hasOwn(targets, target))
  throw new Error("Unsupported runtime target.");
const [platform, arch] = target
  ? targets[target]
  : [process.platform, process.arch];
if (
  !["win32", "darwin", "linux"].includes(platform) ||
  !["x64", "arm64"].includes(arch)
) {
  throw new Error("Unsupported runtime platform or architecture.");
}
const version = "22.23.2";
const nodeName = platform === "win32" ? "node.exe" : "node";

// No shell, no root build (which would recurse through Tauri).
for (const name of ["schema", "bridge"]) {
  const compiler = join(root, "node_modules/typescript/bin/tsc");
  const config = name === "schema" ? "tsconfig.build.json" : "tsconfig.json";
  const result = spawnSync(
    process.execPath,
    [compiler, "-p", join(root, `packages/${name}/${config}`)],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`Failed to build ${name}.`);
}

async function download(url, maxBytes) {
  const parsed = new URL(url);
  if (
    parsed.origin !== "https://nodejs.org" ||
    !parsed.pathname.startsWith(`/dist/v${version}/`)
  ) {
    throw new Error("Only pinned official Node distribution URLs are allowed.");
  }
  const response = await fetch(parsed, {
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Official Node download failed (${response.status}).`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes)
      throw new Error("Node download exceeded size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function boundedStream(stream, maximum = 160 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximum) throw new Error("Archive entry exceeded size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function officialNode(stage) {
  const distribution = `node-v${version}-${platform === "win32" ? "win" : platform}-${arch}`;
  const archiveName = `${distribution}.${platform === "win32" ? "zip" : "tar.gz"}`;
  const base = `https://nodejs.org/dist/v${version}/`;
  const sums = (await download(`${base}SHASUMS256.txt`, 1024 * 1024)).toString(
    "utf8",
  );
  const matches = sums
    .split(/\r?\n/)
    .map((line) => /^([a-f0-9]{64})\s+\*?([^\s]+)$/.exec(line))
    .filter((match) => match?.[2] === archiveName);
  if (matches.length !== 1)
    throw new Error(
      "Archive is not uniquely listed in official SHASUMS256.txt.",
    );
  const archive = await download(`${base}${archiveName}`, 100 * 1024 * 1024);
  if (createHash("sha256").update(archive).digest("hex") !== matches[0][1])
    throw new Error("Node archive checksum mismatch.");
  // Never extract an archive pathname. Only exact regular-file allowlist entries
  // are read into bounded buffers, then written to fixed filenames by us.
  const wanted = new Map([
    [
      `${distribution}/${platform === "win32" ? "node.exe" : "bin/node"}`,
      nodeName,
    ],
    [`${distribution}/LICENSE`, "NODE-LICENSE"],
  ]);
  const found = new Map();
  const archivePath = join(stage, archiveName);
  await writeFile(archivePath, archive);
  if (platform === "win32") {
    await new Promise((resolveArchive, reject) => {
      yauzl.open(archivePath, { lazyEntries: true }, (error, zip) => {
        if (error) return reject(error);
        zip.on("error", reject);
        zip.on("end", resolveArchive);
        zip.on("entry", (entry) => {
          if (!wanted.has(entry.fileName)) return zip.readEntry();
          const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (
            (kind !== 0 && kind !== 0o100000) ||
            found.has(entry.fileName) ||
            entry.uncompressedSize > 160 * 1024 * 1024
          ) {
            zip.close();
            reject(new Error("Invalid Node archive entry."));
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) {
              zip.close();
              reject(streamError);
              return;
            }
            boundedStream(stream)
              .then((data) => {
                found.set(entry.fileName, data);
                zip.readEntry();
              })
              .catch((failure) => {
                zip.close();
                reject(failure);
              });
          });
        });
        zip.readEntry();
      });
    });
  } else {
    const reads = [];
    await readTar({
      file: archivePath,
      onReadEntry(entry) {
        if (!wanted.has(entry.path)) {
          entry.resume();
          return;
        }
        if (
          entry.type !== "File" ||
          found.has(entry.path) ||
          entry.size > 160 * 1024 * 1024
        )
          throw new Error("Invalid Node archive entry.");
        found.set(entry.path, null);
        reads.push(
          boundedStream(entry).then((data) => found.set(entry.path, data)),
        );
      },
    });
    await Promise.all(reads);
  }
  for (const [entry, output] of wanted) {
    if (!found.get(entry))
      throw new Error("Required Node archive entry missing.");
    await writeFile(join(stage, output), found.get(entry));
  }
  await rm(archivePath);
}

const stage = await mkdtemp(join(tmpdir(), "uigrep-runtime-"));
try {
  if (
    !release &&
    platform === process.platform &&
    arch === process.arch &&
    process.versions.node.startsWith("22.")
  ) {
    await copyFile(process.execPath, join(stage, nodeName));
    // Installed Node normally ships LICENSE adjacent (or at prefix root).
    for (const path of [
      join(dirname(process.execPath), "LICENSE"),
      join(dirname(process.execPath), "../LICENSE"),
    ]) {
      try {
        await copyFile(path, join(stage, "NODE-LICENSE"));
        break;
      } catch {
        /* Development copy only. */
      }
    }
  } else {
    await officialNode(stage);
  }
  await chmod(join(stage, nodeName), 0o755);
  await build({
    entryPoints: [join(root, "packages/mcp/src/index.ts")],
    outfile: join(stage, "mcp.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    legalComments: "eof",
    sourcemap: false,
  });
  await writeFile(
    join(stage, "runtime.json"),
    JSON.stringify(
      {
        platform,
        arch,
        nodeVersion: release
          ? version
          : platform === process.platform && arch === process.arch
            ? process.versions.node
            : version,
        release,
      },
      null,
      2,
    ),
  );
  await mkdir(destination, { recursive: true });
  for (const file of [nodeName, "mcp.cjs", "runtime.json", "NODE-LICENSE"]) {
    try {
      const bytes = await readFile(join(stage, file));
      await writeFile(join(destination, `${file}.tmp`), bytes);
      if (file === nodeName)
        await chmod(join(destination, `${file}.tmp`), 0o755);
      await rename(join(destination, `${file}.tmp`), join(destination, file));
    } catch (error) {
      if (file !== "NODE-LICENSE" || release) throw error;
    }
  }
  console.log(
    `Prepared private runtime for ${platform}/${arch} (${release ? "verified official archive" : "development"}).`,
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
