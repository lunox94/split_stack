import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const verifierPath = join(projectRoot, "scripts/verify-xdc.mjs");
const productionArchive = join(projectRoot, "dist-xdc/split-stack.xdc");
const icon = readFileSync(join(projectRoot, "public/icon.png"));
const license = readFileSync(join(projectRoot, "LICENSE"));
const notices = readFileSync(join(projectRoot, "THIRD_PARTY_NOTICES.md"));
const manifest = readFileSync(join(projectRoot, "public/manifest.toml"));
const temporaryDirectories: string[] = [];

interface FixtureEntry {
  readonly compression?: 0 | 8;
  readonly data: Buffer;
  readonly name: string;
  readonly corruptCrc?: boolean;
}

function fixtureCrc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeStoredZip(entries: readonly FixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compression = entry.compression ?? 0;
    const compressed = compression === 8 ? deflateRawSync(entry.data) : entry.data;
    const actualCrc = fixtureCrc32(entry.data);
    const recordedCrc = entry.corruptCrc === true ? (actualCrc ^ 1) >>> 0 : actualCrc;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(compression, 8);
    local.writeUInt32LE(recordedCrc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(compression, 10);
    central.writeUInt32LE(recordedCrc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function validEntries(overrides: Readonly<Record<string, Buffer>> = {}): FixtureEntry[] {
  const values: Record<string, Buffer> = {
    "LICENSE": license,
    "THIRD_PARTY_NOTICES.md": notices,
    "assets/app.css": Buffer.from("body{color:#fff}"),
    "assets/app.js": Buffer.from("document.body.dataset.ready='true'"),
    "icon.png": icon,
    "index.html": Buffer.from(
      '<!doctype html><script src="webxdc.js"></script><link href="./assets/app.css" rel="stylesheet"><script type="module" src="./assets/app.js"></script>',
    ),
    "manifest.toml": manifest,
    ...overrides,
  };
  return Object.entries(values).map(([name, data]) => ({ data, name }));
}

function writeFixture(entries: readonly FixtureEntry[]): string {
  const directory = mkdtempSync(join(tmpdir(), "split-stack-xdc-"));
  temporaryDirectories.push(directory);
  const archivePath = join(directory, "fixture.xdc");
  writeFileSync(archivePath, makeStoredZip(entries));
  return archivePath;
}

function invokeVerifier(archivePath: string) {
  return spawnSync(process.execPath, [verifierPath, archivePath, "--json"], {
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("XDC archive verifier", () => {
  it("accepts safe, self-contained Store and Deflate entries", () => {
    const entries = validEntries().map((entry) =>
      entry.name === "assets/app.js" ? { ...entry, compression: 8 as const } : entry,
    );
    const result = invokeVerifier(writeFixture(entries));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ fileCount: 7, icon: "256x256" });
  });

  it("rejects path traversal before extracting an entry", () => {
    const entries = validEntries();
    entries.push({ data: Buffer.from("escape"), name: "../escape.txt" });
    const result = invokeVerifier(writeFixture(entries));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsafe or ambiguous path");
  });

  it("rejects corrupt payload CRCs", () => {
    const entries = validEntries().map((entry) =>
      entry.name === "assets/app.js" ? { ...entry, corruptCrc: true } : entry,
    );
    const result = invokeVerifier(writeFixture(entries));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CRC mismatch");
  });

  it("rejects source maps and external runtime URLs", () => {
    const sourceMapResult = invokeVerifier(
      writeFixture([
        ...validEntries(),
        { data: Buffer.from("{}"), name: "assets/app.js.map" },
      ]),
    );
    expect(sourceMapResult.status).toBe(1);
    expect(sourceMapResult.stderr).toContain("source map must not be packaged");

    const externalResult = invokeVerifier(
      writeFixture(
        validEntries({
          "index.html": Buffer.from(
            '<!doctype html><script src="webxdc.js"></script><script src="https://example.invalid/app.js"></script>',
          ),
        }),
      ),
    );
    expect(externalResult.status).toBe(1);
    expect(externalResult.stderr).toContain("external runtime reference");

    const networkSinkResult = invokeVerifier(
      writeFixture(
        validEntries({
          "assets/app.js": Buffer.from("fetch('https://example.invalid/state')"),
        }),
      ),
    );
    expect(networkSinkResult.status).toBe(1);
    expect(networkSinkResult.stderr).toContain("external network URL");

    const websocketResult = invokeVerifier(
      writeFixture(
        validEntries({
          "assets/app.js": Buffer.from("new WebSocket('wss://example.invalid/live')"),
        }),
      ),
    );
    expect(websocketResult.status).toBe(1);
    expect(websocketResult.stderr).toContain("external network URL");

    const unquotedResult = invokeVerifier(
      writeFixture(
        validEntries({
          "index.html": Buffer.from(
            '<!doctype html><script src=webxdc.js></script><img srcset="./icon.png 1x, https://example.invalid/icon.png 2x">',
          ),
        }),
      ),
    );
    expect(unquotedResult.status).toBe(1);
    expect(unquotedResult.stderr).toContain("external runtime reference");

    const cssImportResult = invokeVerifier(
      writeFixture(
        validEntries({
          "assets/app.css": Buffer.from('@import "https://example.invalid/theme.css";'),
        }),
      ),
    );
    expect(cssImportResult.status).toBe(1);
    expect(cssImportResult.stderr).toContain("external runtime reference");
  });

  it("allows inert namespace and documentation URI strings in bundled libraries", () => {
    const result = invokeVerifier(
      writeFixture(
        validEntries({
          "assets/app.js": Buffer.from(
            'document.createElementNS("http://www.w3.org/1999/xhtml","canvas");console.warn("https://docs.example.invalid/guide")',
          ),
        }),
      ),
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe.skipIf(!existsSync(productionArchive))("production Split Stack archive", () => {
  it("passes the release verifier and reports its size", () => {
    const output = execFileSync(
      process.execPath,
      [verifierPath, productionArchive, "--json"],
      { encoding: "utf8" },
    );
    const report = JSON.parse(output) as {
      archiveBytes: number;
      fileCount: number;
      icon: string;
      uncompressedBytes: number;
    };
    expect(report.archiveBytes).toBeGreaterThan(0);
    expect(report.uncompressedBytes).toBeGreaterThan(report.archiveBytes);
    expect(report.fileCount).toBeGreaterThanOrEqual(7);
    expect(report.icon).toBe("256x256");
  });
});
