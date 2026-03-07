/**
 * Run with Node.js to generate placeholder icons.
 * Requires the `canvas` package: npm install canvas
 *
 * Usage: node scripts/generate-icons.js
 */

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const SIZES = [16, 48, 128];
const ICON_DIR = path.join(__dirname, '..', 'icons');

if (!fs.existsSync(ICON_DIR)) fs.mkdirSync(ICON_DIR, { recursive: true });

for (const size of SIZES) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background circle
  ctx.fillStyle = '#1a73e8';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // Letter "L" for Lapidary
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(size * 0.55)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('L', size / 2, size / 2 + size * 0.04);

  const outPath = path.join(ICON_DIR, `icon${size}.png`);
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  console.log(`Wrote ${outPath}`);
}
