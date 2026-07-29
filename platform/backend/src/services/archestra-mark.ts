/**
 * The one canonical Archestra header mark, shared by every /connection surface —
 * the setup-script banner AND the startup-guard pre-loader ("startup screen") —
 * on macOS/Linux and Windows, so all of them render the identical logo.
 *
 * `unicode` is the block-glyph art used everywhere a UTF-8-capable terminal is
 * guaranteed: bash (`curl | bash`), the startup guards (the bash guard, and the
 * PowerShell guard which is written to disk as UTF-8-with-BOM so PowerShell
 * decodes it correctly), and the Windows connect banner when the host is
 * capable (Windows Terminal / PowerShell 7). `ascii` is the portable fallback
 * for the legacy Windows console, where the connect banner is streamed inline
 * via `irm | iex` with no BOM and block glyphs would mojibake on the OEM
 * codepage.
 *
 * Both variants are 9 lines with the same layout: the product name is overlaid
 * to the right of {@link ARCHESTRA_MARK_NAME_ROW} and the tagline to the right
 * of {@link ARCHESTRA_MARK_TAGLINE_ROW}.
 */
export const ARCHESTRA_MARK = {
  unicode: [
    "   ╭──────────────────╮",
    "   │                  │",
    "   │        ▟██▙      │",
    "   │        ████      │",
    "   │       ████       │",
    "   │       ████ ▟▙    │",
    "   │      ▜██▛  ▜▛    │",
    "   │                  │",
    "   ╰──────────────────╯",
  ],
  ascii: [
    "   .------------------.",
    "   |                  |",
    "   |        ,##.      |",
    "   |        ####      |",
    "   |       ####       |",
    "   |       #### ,.    |",
    "   |       `##' `'    |",
    "   |                  |",
    "   '------------------'",
  ],
} as const;

type ArchestraMarkVariant = keyof typeof ARCHESTRA_MARK;

/** Row (0-indexed) carrying the product name. */
export const ARCHESTRA_MARK_NAME_ROW = 3;
/** Row (0-indexed) carrying the tagline. */
export const ARCHESTRA_MARK_TAGLINE_ROW = 4;
export const ARCHESTRA_MARK_TAGLINE = "Secure access to your AI tools";
/** Gap between the mark and the overlaid text, shared by every surface. */
export const ARCHESTRA_MARK_GAP = "     ";

/**
 * The mark with the product name + tagline overlaid to the right, as an array
 * of plain lines — used by the setup-script banners (printed verbatim through a
 * quoted heredoc / here-string). The guards render the same art per-line with
 * color, using {@link ARCHESTRA_MARK} + the row constants directly.
 */
export function archestraMarkWithText(params: {
  appName: string;
  variant?: ArchestraMarkVariant;
}): string[] {
  const lines = ARCHESTRA_MARK[params.variant ?? "unicode"];
  return lines.map((line, i) => {
    if (i === ARCHESTRA_MARK_NAME_ROW) {
      return `${line}${ARCHESTRA_MARK_GAP}${params.appName}`;
    }
    if (i === ARCHESTRA_MARK_TAGLINE_ROW) {
      return `${line}${ARCHESTRA_MARK_GAP}${ARCHESTRA_MARK_TAGLINE}`;
    }
    return line;
  });
}
