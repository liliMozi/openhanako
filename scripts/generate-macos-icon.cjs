#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "desktop", "src", "icon.png");
const TARGET = path.join(ROOT, "desktop", "src", "icon.icns");

const CHUNKS = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
];

function sampleArea(source, left, top, right, bottom) {
  const x0 = Math.floor(left);
  const x1 = Math.ceil(right);
  const y0 = Math.floor(top);
  const y1 = Math.ceil(bottom);
  let total = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;

  for (let sy = y0; sy < y1; sy++) {
    if (sy < 0 || sy >= source.height) continue;
    const oy = Math.max(0, Math.min(bottom, sy + 1) - Math.max(top, sy));
    if (oy <= 0) continue;

    for (let sx = x0; sx < x1; sx++) {
      if (sx < 0 || sx >= source.width) continue;
      const ox = Math.max(0, Math.min(right, sx + 1) - Math.max(left, sx));
      if (ox <= 0) continue;

      const weight = ox * oy;
      const index = (sy * source.width + sx) * 4;
      const alpha = source.data[index + 3] / 255;
      const weightedAlpha = alpha * weight;
      r += source.data[index] * weightedAlpha;
      g += source.data[index + 1] * weightedAlpha;
      b += source.data[index + 2] * weightedAlpha;
      a += weightedAlpha;
      total += weight;
    }
  }

  if (total === 0 || a === 0) return [0, 0, 0, 0];

  return [
    Math.round(r / a),
    Math.round(g / a),
    Math.round(b / a),
    Math.round((a / total) * 255),
  ];
}

function renderLayer(source, size) {
  const png = new PNG({ width: size, height: size, colorType: 6 });
  const sourceSize = Math.min(source.width, source.height);
  const sourceX = (source.width - sourceSize) / 2;
  const sourceY = (source.height - sourceSize) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const left = sourceX + (x / size) * sourceSize;
      const top = sourceY + (y / size) * sourceSize;
      const right = sourceX + ((x + 1) / size) * sourceSize;
      const bottom = sourceY + ((y + 1) / size) * sourceSize;
      const [r, g, b, a] = sampleArea(source, left, top, right, bottom);
      const index = (y * size + x) * 4;

      png.data[index] = r;
      png.data[index + 1] = g;
      png.data[index + 2] = b;
      png.data[index + 3] = a;
    }
  }

  return PNG.sync.write(png, { colorType: 6 });
}

function createIcns(chunks) {
  const bodySize = chunks.reduce((sum, chunk) => sum + 8 + chunk.data.length, 0);
  const out = Buffer.alloc(8 + bodySize);
  out.write("icns", 0, "ascii");
  out.writeUInt32BE(out.length, 4);

  let offset = 8;
  for (const chunk of chunks) {
    out.write(chunk.type, offset, "ascii");
    out.writeUInt32BE(8 + chunk.data.length, offset + 4);
    chunk.data.copy(out, offset + 8);
    offset += 8 + chunk.data.length;
  }

  return out;
}

function main() {
  const source = PNG.sync.read(fs.readFileSync(SOURCE));
  const chunks = CHUNKS.map(([type, size]) => ({ type, data: renderLayer(source, size) }));
  fs.writeFileSync(TARGET, createIcns(chunks));
  console.log(`Generated ${path.relative(ROOT, TARGET)} (${CHUNKS.map(([type]) => type).join(", ")})`);
}

main();
