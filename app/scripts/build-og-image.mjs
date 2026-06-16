// One-off OG image renderer.
// Reads og-image.svg from public/ and writes og-image.png alongside it.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

const PUBLIC_DIR = resolve(process.cwd(), "public");
const SVG_PATH = resolve(PUBLIC_DIR, "og-image.svg");
const PNG_PATH = resolve(PUBLIC_DIR, "og-image.png");

const svg = await readFile(SVG_PATH);

const png = await sharp(svg, { density: 144 })
  .resize(1200, 630, { fit: "contain", background: "#FBFAF5" })
  .png()
  .toBuffer();

await writeFile(PNG_PATH, png);

const meta = await sharp(png).metadata();
console.log("Wrote", PNG_PATH);
console.log("Dimensions:", meta.width, "x", meta.height);
console.log("Bytes:", png.length);
