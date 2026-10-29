/**
 * Pure presentation helpers for a skill's version history: which Monaco
 * language a file's path implies.
 *
 * Kept out of the dialog so it is readable on its own — it depends on none of
 * the history's loading, selection, or diff state.
 */

/**
 * The Monaco language for a resource file, taken from its extension. Anything
 * unrecognised reads as plain text rather than guessing — a wrong language
 * highlights a file as something it is not.
 */
export function languageForPath(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return LANGUAGES_BY_EXTENSION[extension] ?? "plaintext";
}

const LANGUAGES_BY_EXTENSION: Record<string, string> = {
  css: "css",
  csv: "plaintext",
  html: "html",
  js: "javascript",
  json: "json",
  jsonl: "json",
  md: "markdown",
  py: "python",
  sh: "shell",
  toml: "ini",
  ts: "typescript",
  txt: "plaintext",
  yaml: "yaml",
  yml: "yaml",
};
