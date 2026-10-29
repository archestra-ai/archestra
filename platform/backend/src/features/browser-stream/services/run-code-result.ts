/**
 * Pull the JSON return value out of Playwright MCP's browser_run_code output,
 * which reports it in a "### Result" section. Null when the code returned
 * nothing.
 */
export function extractRunCodeResult(text: string): string | null {
  const match = text.match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/);
  if (!match) return null;
  const body = match[1]
    .trim()
    .replace(/^```[a-z]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  return body || null;
}
