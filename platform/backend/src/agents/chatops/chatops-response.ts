// Accepts both "Run <id> started" (the start_run tool's own narration) and the
// legacy "Task <id> started" phrasing a model may still produce.
const RUN_ID_PATTERN =
  /\b(?:Run|Task)\s+`?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`?\s+(?:has\s+)?started\b/i;

export function compactChatOpsResponse(text: string): string {
  const runStart = text.match(RUN_ID_PATTERN);
  if (runStart) {
    return `Run ${runStart[1]} started — I’ll post the result here when it’s ready.`;
  }

  const structuredLaunch = extractStructuredRunLaunch(text);
  return structuredLaunch ?? text;
}

function extractStructuredRunLaunch(text: string): string | null {
  const lines = text.split("\n");
  const liveRunIndex = lines.findIndex((line) =>
    /^\s*[•*-]\s*Live run:\s*<?https?:\/\/\S+\/chat\/runs\/[0-9a-f-]+/i.test(
      line,
    ),
  );
  if (liveRunIndex < 0) return null;

  const taskIndex = lines.findLastIndex(
    (line, index) =>
      index < liveRunIndex && /^\s*[•*-]\s*Task:\s*\S/i.test(line),
  );
  if (taskIndex < 0) return null;

  const headingIndex = taskIndex - 1;
  const launchStart =
    headingIndex >= 0 && /\bworking on it\b/i.test(lines[headingIndex])
      ? headingIndex
      : taskIndex;
  return lines.slice(launchStart).join("\n").trim();
}
