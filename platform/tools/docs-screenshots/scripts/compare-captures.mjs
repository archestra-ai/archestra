import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const [first, second] = process.argv.slice(2);
if (!first || !second) {
  throw new Error(
    "Usage: compare-captures.mjs <first raw capture directory> <second raw capture directory>",
  );
}
const list = (directory) =>
  fs.readdirSync(directory, { recursive: true })
    .filter((file) => file.endsWith(".png"))
    .sort();
const files = list(first);
if (!files.length || JSON.stringify(files) !== JSON.stringify(list(second))) {
  throw new Error(
    "Capture sets differ or are empty; compare the same manifest subset in both runs.",
  );
}
let changed = 0;
for (const file of files) {
  const [a, b] = await Promise.all(
    [first, second].map(async (directory) => {
      const image = await sharp(path.join(directory, file))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return {
        width: image.info.width,
        height: image.info.height,
        hash: createHash("sha256").update(image.data).digest("hex"),
      };
    }),
  );
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    console.error(`Changed: ${file} (${a.hash} -> ${b.hash})`);
    changed++;
  } else {
    console.log(`${a.hash}  ${file}`);
  }
}
console.log(`${files.length - changed}/${files.length} captures have identical decoded pixels.`);
if (changed) process.exitCode = 1;
