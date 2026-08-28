const TASK_ID_PATTERN =
  /\bTask\s+`?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`?\s+(?:has\s+)?started\b/i;

export function compactChatOpsResponse(text: string): string {
  const taskStart = text.match(TASK_ID_PATTERN);
  if (!taskStart) return text;

  return `Task ${taskStart[1]} started — I’ll post the result here when it’s ready.`;
}
