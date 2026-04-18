// plugins/image-gen/lib/image-size.js
import { createReadStream } from "node:fs";

/**
 * 从文件头读取图片宽高（不完整解码）。
 * 支持 PNG 和 JPEG。视频文件返回 null。
 */
export async function readImageSize(filePath) {
  if (filePath.endsWith(".mp4") || filePath.endsWith(".mov")) return null;

  const chunks = [];
  let totalLen = 0;
  const NEEDED = 32 * 1024;

  return new Promise((resolve) => {
    const stream = createReadStream(filePath, { start: 0, end: NEEDED - 1 });
    stream.on("data", (chunk) => { chunks.push(chunk); totalLen += chunk.length; });
    stream.on("end", () => {
      const buf = Buffer.concat(chunks, totalLen);
      resolve(parseSize(buf));
    });
    stream.on("error", () => resolve(null));
  });
}

function parseSize(buf) {
  if (buf.length < 8) return null;

  // PNG: bytes 0-7 = signature, IHDR at byte 16: width(4) + height(4)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    if (buf.length < 24) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // JPEG: scan for SOF0 (0xFF 0xC0) or SOF2 (0xFF 0xC2)
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xFF) break;
      const marker = buf[offset + 1];
      if (marker === 0xC0 || marker === 0xC2) {
        return {
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
        };
      }
      const segLen = buf.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    }
  }

  return null;
}
