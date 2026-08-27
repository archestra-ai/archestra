const TASK_ID_PATTERN =
  /\bTask\s+`?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`?\s+(?:has\s+)?started\b/i;

export function compactChatOpsResponse(text: string): string {
  const taskStart = text.match(TASK_ID_PATTERN);
  if (!taskStart) return text;

  const resultName = /\b(?:PR|pull request)\b/i.test(text) ? "PR" : "result";
  return `🦀 Task ${taskStart[1]} started — I’ll post the ${resultName} here when it’s ready.`;
}

export function isBackgroundExecutionRequest(text: string): boolean {
  return /^(?:🦀|:crab:)\s*/i.test(text.trimStart());
}
