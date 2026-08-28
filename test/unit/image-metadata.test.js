import test from "node:test";
import assert from "node:assert/strict";

import { readImageMetadata } from "../../src/export/image-metadata.js";

function jpeg(width, height) {
  const buffer = Buffer.alloc(22);
  Buffer.from("ffd8ffc0001108", "hex").copy(buffer);
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

function webp(width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBPVP8X", 8, "ascii");
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

function gif(width, height) {
  const buffer = Buffer.alloc(10);
  buffer.write("GIF89a", 0, "ascii");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

function avif(width, height) {
  const buffer = Buffer.alloc(44);
  buffer.writeUInt32BE(24, 0);
  buffer.write("ftypavif", 4, "ascii");
  buffer.writeUInt32BE(20, 24);
  buffer.write("ispe", 28, "ascii");
  buffer.writeUInt32BE(width, 36);
  buffer.writeUInt32BE(height, 40);
  return buffer;
}

test("识别常见网页图片的真实格式与尺寸", () => {
  assert.deepEqual(readImageMetadata(jpeg(1440, 1800)), {
    width: 1440,
    height: 1800,
    extension: ".jpg",
    contentType: "image/jpeg",
  });
  assert.deepEqual(readImageMetadata(webp(1280, 960)), {
    width: 1280,
    height: 960,
    extension: ".webp",
    contentType: "image/webp",
  });
  assert.deepEqual(readImageMetadata(gif(800, 600)), {
    width: 800,
    height: 600,
    extension: ".gif",
    contentType: "image/gif",
  });
  assert.deepEqual(readImageMetadata(avif(1080, 1350)), {
    width: 1080,
    height: 1350,
    extension: ".avif",
    contentType: "image/avif",
  });
  assert.equal(readImageMetadata(Buffer.from("not-an-image")), null);
});
