import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("压缩包中央目录不存在");
}

export async function readZipEntries(filePath) {
  const buffer = await readFile(filePath);
  const entries = new Map();
  const endOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let centralOffset = buffer.readUInt32LE(endOffset + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error("压缩包中央目录损坏");
    const method = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const nameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localOffset = buffer.readUInt32LE(centralOffset + 42);
    const name = buffer.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const body = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    if (body === null) throw new Error(`不支持的压缩方式：${method}`);
    entries.set(name, body);
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
