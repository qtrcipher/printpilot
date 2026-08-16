// Renders build/icon.svg to build/icon.png (512x512) for electron-builder.
// Run: npm run icon
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svgPath = path.join(root, 'build', 'icon.svg');
const pngPath = path.join(root, 'build', 'icon.png');

const svg = await readFile(svgPath);
const png = await sharp(svg, { density: 384 }).resize(512, 512).png().toBuffer();
await writeFile(pngPath, png);

const meta = await sharp(pngPath).metadata();
if (meta.width !== 512 || meta.height !== 512) {
  throw new Error(`icon.png is ${meta.width}x${meta.height}, expected 512x512`);
}
console.log(`wrote ${pngPath} (${meta.width}x${meta.height})`);
