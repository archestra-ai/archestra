import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { DOCS_ASSETS_DIR } from "./env";

export type Theme = "light" | "dark";

/** `x.webp` is the light capture (what markdown embeds); `x.dark.webp` is its twin. */
export function assetPath(asset: string, theme: Theme): string {
  return path.join(
    DOCS_ASSETS_DIR,
    `${asset}${theme === "dark" ? ".dark" : ""}.webp`,
  );
}

/**
 * Writes the capture as WebP unless it is visually identical to the file already
 * there. Re-encoding alone changes bytes, so without this every run would rewrite
 * every image and CI would commit noise.
 */
export async function writeIfChanged(params: {
  png: Buffer;
  file: string;
}): Promise<"created" | "updated" | "unchanged"> {
  const webp = await sharp(params.png)
    .webp({ quality: WEBP_QUALITY, effort: 6 })
    .toBuffer();

  if (!fs.existsSync(params.file)) {
    fs.mkdirSync(path.dirname(params.file), { recursive: true });
    fs.writeFileSync(params.file, webp);
    return "created";
  }

  if (await looksTheSame(webp, fs.readFileSync(params.file))) {
    return "unchanged";
  }
  fs.writeFileSync(params.file, webp);
  return "updated";
}

// =============================================================================
// Internal helpers
// =============================================================================

const WEBP_QUALITY = 85;
/** Per-channel difference below which a pixel counts as unchanged (lossy noise). */
const CHANNEL_TOLERANCE = 24;
/** Share of pixels allowed to differ before the image counts as changed. */
const CHANGED_PIXEL_RATIO = 0.0005;

async function looksTheSame(next: Buffer, previous: Buffer): Promise<boolean> {
  const [a, b] = await Promise.all([
    sharp(next).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(previous).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    return false;
  }
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs(a.data[i] - b.data[i]) > CHANNEL_TOLERANCE ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > CHANNEL_TOLERANCE ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > CHANNEL_TOLERANCE
    ) {
      changed++;
    }
  }
  return changed / (a.info.width * a.info.height) <= CHANGED_PIXEL_RATIO;
}
