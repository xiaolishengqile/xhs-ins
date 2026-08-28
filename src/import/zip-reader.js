import { inflateRawSync } from "node:zlib";

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_XML_BYTES = 25 * 1024 * 1024;

function invalidArchive() {
  const error = new Error("文档文件已损坏或不是有效的文档");
  error.statusCode = 400;
  return error;
}

function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_SIGNATURE) return offset;
  }
  throw invalidArchive();
}

function inside(buffer, offset, length) {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset + length <= buffer.length;
}

export function readSelectedZipEntries(buffer, include) {
  try {
    const entries = new Map();
    const endOffset = findEndOfCentralDirectory(buffer);
    const entryCount = buffer.readUInt16LE(endOffset + 10);
    let centralOffset = buffer.readUInt32LE(endOffset + 16);
    let expandedBytes = 0;

    for (let index = 0; index < entryCount; index += 1) {
      if (!inside(buffer, centralOffset, 46) || buffer.readUInt32LE(centralOffset) !== CENTRAL_SIGNATURE) {
        throw invalidArchive();
      }
      const flags = buffer.readUInt16LE(centralOffset + 8);
      const method = buffer.readUInt16LE(centralOffset + 10);
      const compressedSize = buffer.readUInt32LE(centralOffset + 20);
      const uncompressedSize = buffer.readUInt32LE(centralOffset + 24);
      const nameLength = buffer.readUInt16LE(centralOffset + 28);
      const extraLength = buffer.readUInt16LE(centralOffset + 30);
      const commentLength = buffer.readUInt16LE(centralOffset + 32);
      const localOffset = buffer.readUInt32LE(centralOffset + 42);
      if (!inside(buffer, centralOffset + 46, nameLength + extraLength + commentLength)) throw invalidArchive();
      const name = buffer.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString("utf8");

      if (include(name)) {
        if ((flags & 1) !== 0 || !inside(buffer, localOffset, 30) || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
          throw invalidArchive();
        }
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
        if (!inside(buffer, dataOffset, compressedSize)) throw invalidArchive();
        expandedBytes += uncompressedSize;
        if (expandedBytes > MAX_XML_BYTES) {
          const error = new Error("文档内容过大");
          error.statusCode = 413;
          throw error;
        }
        const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
        const body = method === 0
          ? compressed
          : method === 8
            ? inflateRawSync(compressed, { maxOutputLength: MAX_XML_BYTES })
            : null;
        if (body === null) throw invalidArchive();
        entries.set(name, body);
      }
      centralOffset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } catch (error) {
    if (error?.statusCode) throw error;
    throw invalidArchive();
  }
}
