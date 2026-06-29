export function mapThemeFontValue(value: string): string {
  const primaryFamily = getPrimaryFontFamily(value);
  return FONT_VARIABLE_BY_PRIMARY_FAMILY[primaryFamily] ?? value;
}

const FONT_VARIABLE_BY_PRIMARY_FAMILY: Record<string, string> = {
  "DM Sans": "var(--font-dm-sans)",
  Inter: "var(--font-inter)",
  "JetBrains Mono": "var(--font-jetbrains-mono)",
  Lato: "var(--font-lato)",
  "Libre Baskerville": "var(--font-libre-baskerville)",
  Merriweather: "var(--font-merriweather)",
  Montserrat: "var(--font-montserrat)",
  "Open Sans": "var(--font-open-sans)",
  Outfit: "var(--font-outfit)",
  Oxanium: "var(--font-oxanium)",
  Poppins: "var(--font-poppins)",
  "Plus Jakarta Sans": "var(--font-plus-jakarta-sans)",
  Quicksand: "var(--font-quicksand)",
  Roboto: "var(--font-roboto)",
  "Source Code Pro": "var(--font-source-code-pro)",
  "Source Sans 3": "var(--font-source-sans)",
};

function getPrimaryFontFamily(value: string): string {
  return (
    value
      .split(",")[0]
      ?.trim()
      .replace(/^['"]|['"]$/g, "") ?? value
  );
}
