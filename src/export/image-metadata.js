const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const JPEG_START_OF_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function metadata(width, height, extension, contentType) {
  if (!width || !height) return null;
  return { width, height, extension, contentType };
}

function jpegMetadata(buffer) {
  if (buffer.length < 11 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (JPEG_START_OF_FRAME.has(marker)) {
      return metadata(buffer.readUInt16BE(offset + 7), buffer.readUInt16BE(offset + 5), ".jpg", "image/jpeg");
    }
    if (offset + 4 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += length + 2;
  }
  return null;
}

function webpMetadata(buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  const kind = buffer.toString("ascii", 12, 16);
  if (kind === "VP8X") {
    return metadata(buffer.readUIntLE(24, 3) + 1, buffer.readUIntLE(27, 3) + 1, ".webp", "image/webp");
  }
  if (kind === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return metadata((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, ".webp", "image/webp");
  }
  const frame = buffer.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
  if (kind === "VP8 " && frame >= 0 && frame + 7 <= buffer.length) {
    return metadata(buffer.readUInt16LE(frame + 3) & 0x3fff, buffer.readUInt16LE(frame + 5) & 0x3fff, ".webp", "image/webp");
  }
  return null;
}

function avifMetadata(buffer) {
  if (buffer.length < 32 || buffer.toString("ascii", 4, 8) !== "ftyp") return null;
  const brands = buffer.toString("ascii", 8, Math.min(buffer.length, 32));
  if (!brands.includes("avif") && !brands.includes("avis")) return null;
  const typeOffset = buffer.indexOf(Buffer.from("ispe"));
  if (typeOffset < 4 || typeOffset + 16 > buffer.length) return null;
  return metadata(buffer.readUInt32BE(typeOffset + 8), buffer.readUInt32BE(typeOffset + 12), ".avif", "image/avif");
}

export function readImageMetadata(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return metadata(buffer.readUInt32BE(16), buffer.readUInt32BE(20), ".png", "image/png");
  }
  const jpeg = jpegMetadata(buffer);
  if (jpeg) return jpeg;
  if (buffer.length >= 10 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) {
    return metadata(buffer.readUInt16LE(6), buffer.readUInt16LE(8), ".gif", "image/gif");
  }
  return webpMetadata(buffer) ?? avifMetadata(buffer);
}
