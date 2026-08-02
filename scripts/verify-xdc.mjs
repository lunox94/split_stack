#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { basename, dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557;
const MAX_ENTRIES = 4_096;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const REQUIRED_ROOT_FILES = [
  "index.html",
  "manifest.toml",
  "icon.png",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
];
const RUNTIME_TEXT_EXTENSION = /\.(?:html?|css|js|mjs|cjs|json|svg|xml)$/i;
const SOURCE_MAP_EXTENSION = /\.map$/i;

export class XdcVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "XdcVerificationError";
  }
}

function invariant(condition, message) {
  if (!condition) throw new XdcVerificationError(message);
}

function ensureRange(buffer, offset, length, context) {
  invariant(
    Number.isSafeInteger(offset) &&
      Number.isSafeInteger(length) &&
      offset >= 0 &&
      length >= 0 &&
      offset + length <= buffer.length,
    `${context} extends beyond the archive`,
  );
}

function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    ensureRange(buffer, offset, 22, "end-of-central-directory record");
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw new XdcVerificationError("archive has no valid end-of-central-directory record");
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeEntryName(bytes, flags) {
  invariant((flags & 0x1) === 0, "encrypted ZIP entries are not allowed");
  const utf8 = (flags & 0x800) !== 0;
  invariant(utf8 || bytes.every((byte) => byte < 0x80), "non-UTF-8 entry name is not portable");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function validateEntryName(name) {
  invariant(name.length > 0, "archive contains an empty entry name");
  invariant(!name.includes("\0"), `entry name contains NUL: ${JSON.stringify(name)}`);
  invariant(!name.includes("\\"), `entry uses a backslash path: ${name}`);
  invariant(!name.startsWith("/"), `entry uses an absolute path: ${name}`);
  invariant(!/^[A-Za-z]:/.test(name), `entry uses a drive path: ${name}`);
  const segments = name.split("/");
  invariant(
    segments.every((segment, index) =>
      segment !== "." && segment !== ".." && (segment.length > 0 || index === segments.length - 1),
    ),
    `entry uses an unsafe or ambiguous path: ${name}`,
  );
  const normalized = posix.normalize(name);
  invariant(normalized === name, `entry path is not canonical: ${name}`);
}

function extractEntryData(archive, central) {
  const {
    compressedSize,
    compression,
    crc,
    flags,
    localOffset,
    name,
    uncompressedSize,
  } = central;
  ensureRange(archive, localOffset, 30, `local header for ${name}`);
  invariant(archive.readUInt32LE(localOffset) === LOCAL_SIGNATURE, `invalid local header for ${name}`);
  const localFlags = archive.readUInt16LE(localOffset + 6);
  const localCompression = archive.readUInt16LE(localOffset + 8);
  const localNameLength = archive.readUInt16LE(localOffset + 26);
  const localExtraLength = archive.readUInt16LE(localOffset + 28);
  invariant(localFlags === flags, `local and central flags differ for ${name}`);
  invariant(localCompression === compression, `local and central compression differ for ${name}`);
  ensureRange(archive, localOffset + 30, localNameLength + localExtraLength, `local metadata for ${name}`);
  const localName = decodeEntryName(
    archive.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    flags,
  );
  invariant(localName === name, `local and central names differ for ${name}`);

  if ((flags & 0x8) === 0) {
    invariant(archive.readUInt32LE(localOffset + 14) === crc, `local CRC differs for ${name}`);
    invariant(
      archive.readUInt32LE(localOffset + 18) === compressedSize,
      `local compressed size differs for ${name}`,
    );
    invariant(
      archive.readUInt32LE(localOffset + 22) === uncompressedSize,
      `local uncompressed size differs for ${name}`,
    );
  }

  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  ensureRange(archive, dataOffset, compressedSize, `compressed data for ${name}`);
  const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
  let data;
  if (compression === 0) {
    invariant(compressedSize === uncompressedSize, `stored entry has inconsistent sizes: ${name}`);
    data = Buffer.from(compressed);
  } else if (compression === 8) {
    try {
      data = inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch (error) {
      throw new XdcVerificationError(
        `cannot inflate ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    throw new XdcVerificationError(`unsupported compression method ${compression} for ${name}`);
  }
  invariant(data.length === uncompressedSize, `uncompressed size differs for ${name}`);
  invariant(crc32(data) === crc, `CRC mismatch for ${name}`);
  return data;
}

export function readXdcArchive(archivePath) {
  const absolutePath = resolve(archivePath);
  const archive = readFileSync(absolutePath);
  invariant(archive.length >= 22, "archive is too short to be a ZIP file");
  const eocdOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(eocdOffset + 4);
  const centralDisk = archive.readUInt16LE(eocdOffset + 6);
  const diskEntries = archive.readUInt16LE(eocdOffset + 8);
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  invariant(diskNumber === 0 && centralDisk === 0, "multi-disk ZIP archives are not supported");
  invariant(diskEntries === entryCount, "central-directory entry counts disagree");
  invariant(entryCount > 0 && entryCount <= MAX_ENTRIES, `invalid ZIP entry count: ${entryCount}`);
  invariant(
    entryCount !== 0xffff && centralSize !== 0xffffffff && centralOffset !== 0xffffffff,
    "ZIP64 archives are not supported",
  );
  ensureRange(archive, centralOffset, centralSize, "central directory");
  invariant(centralOffset + centralSize <= eocdOffset, "central directory overlaps its footer");

  const entries = new Map();
  const caseFoldedNames = new Set();
  let totalUncompressedBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    ensureRange(archive, cursor, 46, `central header ${index}`);
    invariant(archive.readUInt32LE(cursor) === CENTRAL_SIGNATURE, `invalid central header ${index}`);
    const flags = archive.readUInt16LE(cursor + 8);
    const compression = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const diskStart = archive.readUInt16LE(cursor + 34);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    ensureRange(archive, cursor + 46, nameLength + extraLength + commentLength, `metadata for entry ${index}`);
    invariant(diskStart === 0, "multi-disk entry encountered");
    invariant(
      compressedSize !== 0xffffffff && uncompressedSize !== 0xffffffff && localOffset !== 0xffffffff,
      "ZIP64 entry encountered",
    );
    const name = decodeEntryName(archive.subarray(cursor + 46, cursor + 46 + nameLength), flags);
    validateEntryName(name);
    invariant(!entries.has(name), `duplicate ZIP entry: ${name}`);
    const folded = name.toLocaleLowerCase("en-US");
    invariant(!caseFoldedNames.has(folded), `case-colliding ZIP entry: ${name}`);
    caseFoldedNames.add(folded);
    invariant(uncompressedSize <= MAX_ENTRY_BYTES, `entry is too large: ${name}`);
    totalUncompressedBytes += uncompressedSize;
    invariant(totalUncompressedBytes <= MAX_TOTAL_BYTES, "archive expands beyond the verification limit");
    const unixType = (externalAttributes >>> 16) & 0xf000;
    invariant(unixType !== 0xa000, `symbolic links are not allowed: ${name}`);

    const isDirectory = name.endsWith("/");
    const data = isDirectory
      ? Buffer.alloc(0)
      : extractEntryData(archive, {
          compressedSize,
          compression,
          crc,
          flags,
          localOffset,
          name,
          uncompressedSize,
        });
    entries.set(name, {
      compressedSize,
      compression,
      crc,
      data,
      isDirectory,
      name,
      uncompressedSize,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  invariant(cursor === centralOffset + centralSize, "central-directory size does not match its entries");
  return {
    archiveBytes: archive.length,
    archivePath: absolutePath,
    entries,
    totalUncompressedBytes,
  };
}

function parsePngDimensions(data) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  invariant(data.length >= 33 && data.subarray(0, 8).equals(signature), "icon.png is not a PNG file");
  invariant(data.readUInt32BE(8) === 13, "icon.png has an invalid IHDR length");
  invariant(data.toString("ascii", 12, 16) === "IHDR", "icon.png does not begin with IHDR");
  invariant(crc32(data.subarray(12, 29)) === data.readUInt32BE(29), "icon.png has an invalid IHDR CRC");
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function resolveArchiveReference(fromName, reference) {
  const clean = reference.split("#", 1)[0].split("?", 1)[0];
  if (clean === "" || clean.startsWith("data:") || clean.startsWith("blob:")) return undefined;
  invariant(!clean.startsWith("/"), `root-absolute runtime reference in ${fromName}: ${reference}`);
  invariant(!/^[A-Za-z][A-Za-z\d+.-]*:/.test(clean), `external runtime reference in ${fromName}: ${reference}`);
  const decoded = decodeURIComponent(clean);
  const target = posix.normalize(posix.join(posix.dirname(fromName), decoded));
  validateEntryName(target);
  return target;
}

function verifyAssetReferences(entries) {
  const index = entries.get("index.html").data.toString("utf8");
  const attributePattern = /\b(?:src|href|poster)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gi;
  let hostScriptSeen = false;
  for (const match of index.matchAll(attributePattern)) {
    const reference = match[1] ?? match[2] ?? match[3];
    if (reference === undefined) continue;
    if (reference === "webxdc.js") {
      hostScriptSeen = true;
      continue;
    }
    const target = resolveArchiveReference("index.html", reference);
    if (target !== undefined) invariant(entries.has(target), `index.html references missing asset: ${target}`);
  }
  const srcsetPattern = /\bsrcset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gi;
  for (const match of index.matchAll(srcsetPattern)) {
    const candidates = (match[1] ?? match[2] ?? match[3] ?? "").split(",");
    for (const candidate of candidates) {
      const reference = candidate.trim().split(/\s+/, 1)[0];
      if (reference === undefined || reference === "") continue;
      const target = resolveArchiveReference("index.html", reference);
      if (target !== undefined) invariant(entries.has(target), `index.html references missing asset: ${target}`);
    }
  }
  invariant(hostScriptSeen, "index.html must load the host-provided webxdc.js using a relative path");

  const cssUrlPattern = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  const cssImportPattern = /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?/gi;
  for (const entry of entries.values()) {
    if (entry.isDirectory || !entry.name.endsWith(".css")) continue;
    const css = entry.data.toString("utf8");
    for (const match of css.matchAll(cssUrlPattern)) {
      const target = resolveArchiveReference(entry.name, match[1].trim());
      if (target !== undefined) invariant(entries.has(target), `${entry.name} references missing asset: ${target}`);
    }
    for (const match of css.matchAll(cssImportPattern)) {
      const target = resolveArchiveReference(entry.name, match[1].trim());
      if (target !== undefined) invariant(entries.has(target), `${entry.name} references missing asset: ${target}`);
    }
  }
}

function verifyNoExternalRuntimeAccess(entries) {
  // Vendor code can legitimately contain inert URI identifiers (for example
  // the XHTML namespace used by document.createElementNS) or a documentation
  // URL in a warning. Reject URL literals only when they are statically wired
  // to a network-capable sink; HTML and CSS references are checked separately.
  const staticExternalNetworkSink = new RegExp(
    String.raw`\b(?:fetch|WebSocket|EventSource|import)\s*\(\s*["'\x60]\s*(?:(?:https?|wss?):)?//|` +
      String.raw`\bsendBeacon\s*\(\s*["'\x60]\s*(?:(?:https?|wss?):)?//|` +
      String.raw`\.open\s*\(\s*["'\x60][A-Z]+["'\x60]\s*,\s*["'\x60]\s*(?:(?:https?|wss?):)?//`,
    "i",
  );
  for (const entry of entries.values()) {
    if (entry.isDirectory || !RUNTIME_TEXT_EXTENSION.test(entry.name)) continue;
    const text = entry.data.toString("utf8");
    invariant(
      !staticExternalNetworkSink.test(text),
      `external network URL found in runtime file: ${entry.name}`,
    );
    invariant(!/sourceMappingURL\s*=/.test(text), `source-map reference found in runtime file: ${entry.name}`);
  }
}

export function verifyXdc(archivePath) {
  const result = readXdcArchive(archivePath);
  const { entries } = result;
  for (const required of REQUIRED_ROOT_FILES) {
    invariant(entries.has(required) && !entries.get(required).isDirectory, `missing root file: ${required}`);
  }
  for (const entry of entries.values()) {
    invariant(entry.compression === 0 || entry.compression === 8, `invalid compression for ${entry.name}`);
    invariant(!SOURCE_MAP_EXTENSION.test(entry.name), `source map must not be packaged: ${entry.name}`);
    invariant(basename(entry.name) !== "webxdc.js", `host-provided webxdc.js must not be packaged: ${entry.name}`);
  }

  const manifest = entries.get("manifest.toml").data.toString("utf8");
  invariant(/^\s*name\s*=\s*["']Split Stack["']\s*$/m.test(manifest), "manifest name is not Split Stack");
  invariant(
    /^\s*source_code_url\s*=\s*["'][^"']+["']\s*$/m.test(manifest),
    "manifest has no source_code_url",
  );

  const icon = parsePngDimensions(entries.get("icon.png").data);
  invariant(icon.width === icon.height, `icon must be square, got ${icon.width}x${icon.height}`);
  invariant(icon.width >= 128 && icon.width <= 512, `icon dimensions must be 128–512 px, got ${icon.width}`);
  verifyAssetReferences(entries);
  verifyNoExternalRuntimeAccess(entries);
  return {
    ...result,
    fileCount: [...entries.values()].filter((entry) => !entry.isDirectory).length,
    icon,
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function runCli() {
  const arguments_ = process.argv.slice(2);
  const json = arguments_.includes("--json");
  const archiveArgument = arguments_.find((argument) => !argument.startsWith("--"));
  const archivePath = archiveArgument ?? "dist-xdc/split-stack.xdc";
  try {
    const result = verifyXdc(archivePath);
    const summary = {
      archive: result.archivePath,
      archiveBytes: result.archiveBytes,
      archiveSize: formatBytes(result.archiveBytes),
      fileCount: result.fileCount,
      icon: `${result.icon.width}x${result.icon.height}`,
      uncompressedBytes: result.totalUncompressedBytes,
      uncompressedSize: formatBytes(result.totalUncompressedBytes),
    };
    if (json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Verified ${summary.archive}: ${summary.fileCount} files, ${summary.archiveSize} archive, ` +
          `${summary.uncompressedSize} uncompressed, ${summary.icon} icon.\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`XDC verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) runCli();
