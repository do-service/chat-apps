import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { load, JSON_SCHEMA } from "js-yaml";
import { blake2b } from "@noble/hashes/blake2.js";

const MAX_MAP = 4 * 1024 * 1024;
function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid preview ${message}`);
}
function exactKeys(value, required, optional = []) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
async function regularFile(filename, maxSize) {
  const info = await lstat(filename);
  requireValue(info.isFile() && info.size > 0 && info.size <= maxSize, "non-empty regular file or size limit");
  return info;
}
async function hashFile(filename) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("base64");
}
async function verifyBlockmap(filename, bytes, format, payloadSize) {
  let map;
  try {
    const decoded = (format === "gzip" ? gunzipSync : inflateRawSync)(bytes, { maxOutputLength: 16 * 1024 * 1024 });
    map = load(decoded.toString("utf8"), { schema: JSON_SCHEMA });
  } catch { throw new Error("Invalid preview blockmap encoding"); }
  requireValue(exactKeys(map, ["version", "files"]) && map.version === "2" && Array.isArray(map.files) && map.files.length === 1, "blockmap schema");
  const file = map.files[0];
  requireValue(exactKeys(file, ["name", "offset", "checksums", "sizes"]) && file.name === "file" && file.offset === 0, "blockmap file");
  requireValue(Array.isArray(file.sizes) && Array.isArray(file.checksums) && file.sizes.length > 0
    && file.sizes.length <= 500000 && file.sizes.length === file.checksums.length, "blockmap chunks");
  const handle = await open(filename, "r");
  let offset = 0;
  try {
    for (let index = 0; index < file.sizes.length; index++) {
      const size = file.sizes[index];
      const checksum = file.checksums[index];
      requireValue(Number.isSafeInteger(size) && size > 0 && size <= 1024 * 1024 && offset + size <= payloadSize, "blockmap chunk bounds");
      requireValue(typeof checksum === "string" && /^[A-Za-z0-9+/]{24}$/.test(checksum), "blockmap checksum encoding");
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, offset);
      requireValue(bytesRead === size && Buffer.from(blake2b(buffer, { dkLen: 18 })).toString("base64") === checksum, "blockmap checksum mismatch");
      offset += size;
    }
  } finally { await handle.close(); }
  requireValue(offset === payloadSize, "blockmap asset size mismatch");
}

// Only the pinned builder's single NSIS/AppImage output shape is publishable.
export async function verifyPreviewMetadata(release, platform, assetName, version) {
  const metadataName = platform === "windows" ? "preview.yml" : "preview-linux.yml";
  const metadataFile = path.join(release, metadataName);
  await regularFile(metadataFile, 65536);
  let metadata;
  try { metadata = load(await readFile(metadataFile, "utf8"), { schema: JSON_SCHEMA }); }
  catch { throw new Error("Invalid preview metadata YAML"); }
  requireValue(exactKeys(metadata, ["version", "files", "path", "sha512", "releaseDate"]), "metadata keys");
  requireValue(metadata.version === version && Array.isArray(metadata.files) && metadata.files.length === 1, "metadata version or assets");
  requireValue(typeof metadata.releaseDate === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(metadata.releaseDate)
    && !Number.isNaN(Date.parse(metadata.releaseDate)), "metadata release date");
  const file = metadata.files[0];
  requireValue(exactKeys(file, ["url", "sha512", "size"], platform === "linux" ? ["blockMapSize"] : ["isAdminRightsRequired"]), "metadata file keys");
  requireValue(file.url === assetName && metadata.path === assetName && metadata.sha512 === file.sha512, "metadata asset binding");
  requireValue(typeof file.sha512 === "string" && /^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
    && Buffer.from(file.sha512, "base64").toString("base64") === file.sha512, "metadata sha512 encoding");
  const asset = path.join(release, assetName);
  const info = await regularFile(asset, 2 * 1024 * 1024 * 1024);
  requireValue(Number.isSafeInteger(file.size) && file.size === info.size, "metadata asset size mismatch");
  requireValue(await hashFile(asset) === file.sha512, "metadata sha512 mismatch");
  if (platform === "windows") {
    requireValue(file.isAdminRightsRequired === undefined || file.isAdminRightsRequired === false, "metadata unexpected elevation");
    const name = `${assetName}.blockmap`;
    const blockmap = path.join(release, name);
    await regularFile(blockmap, MAX_MAP);
    await verifyBlockmap(asset, await readFile(blockmap), "gzip", info.size);
    return [name, metadataName];
  }
  requireValue(Number.isSafeInteger(file.blockMapSize) && file.blockMapSize > 0 && file.blockMapSize <= MAX_MAP
    && file.blockMapSize + 4 < info.size, "blockmap embedded size");
  const handle = await open(asset, "r");
  const bytes = Buffer.alloc(file.blockMapSize + 4);
  try {
    const result = await handle.read(bytes, 0, bytes.length, info.size - bytes.length);
    requireValue(result.bytesRead === bytes.length && bytes.readUInt32BE(file.blockMapSize) === file.blockMapSize, "blockmap embedded header");
  } finally { await handle.close(); }
  await verifyBlockmap(asset, bytes.subarray(0, file.blockMapSize), "deflate", info.size - bytes.length);
  return [metadataName];
}
