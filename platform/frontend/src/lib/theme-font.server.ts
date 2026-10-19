import { readdirSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_THEME_ID,
  getThemeItemById,
  type OrganizationTheme,
} from "@archestra/shared";

/**
 * The URL of the font file the theme's text uses on first paint, for a
 * `<link rel="preload">`, or null when it is not one of the fonts listed
 * below or its file is not found. The build names the file with a content
 * hash, so it is looked up once among the build's static media.
 */
export async function getThemeFontPreload(
  theme: OrganizationTheme | null,
): Promise<string | null> {
  const family = primaryFamily(
    getThemeItemById(theme ?? DEFAULT_THEME_ID)?.cssVars.theme["font-sans"],
  );
  const base = family ? PRELOADED_FONT_FILE_BY_FAMILY[family] : undefined;
  return base ? (emittedFontFiles().get(base) ?? null) : null;
}

// ===

/**
 * The source file of each font the layout can preload, as the build names
 * it: `Inter-Variable.woff2` becomes `Inter_Variable-s.<hash>.woff2` (the
 * `-s` marks a face with an adjusted fallback). Inter preloads its latin
 * subset only.
 */
const PRELOADED_FONT_FILE_BY_FAMILY: Record<string, string> = {
  Geist: "Geist_Variable",
  Inter: "Inter_Variable_latin",
};

let fontFiles: Map<string, string> | null = null;

function emittedFontFiles(): Map<string, string> {
  if (fontFiles) return fontFiles;
  const files = new Map<string, string>();
  try {
    const media = path.join(
      process.cwd(),
      process.env.NEXT_DIST_DIR || ".next",
      "static",
      "media",
    );
    for (const file of readdirSync(media)) {
      const match = /^(.+?)(?:-s)?\.(?:p\.)?[^.]+\.woff2$/.exec(file);
      if (match?.[1]) files.set(match[1], `/_next/static/media/${file}`);
    }
  } catch {
    // No build output to read (the dev server): nothing is preloaded.
  }
  fontFiles = files;
  return files;
}

function primaryFamily(value: string | undefined): string | undefined {
  return value
    ?.split(",")[0]
    ?.trim()
    .replace(/^['"]|['"]$/g, "");
}
