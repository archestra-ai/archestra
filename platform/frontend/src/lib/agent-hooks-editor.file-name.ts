/**
 * File-name derivation for the agent hooks editor. The file name input was
 * dropped from the UI: the stored name (which picks the interpreter — .py vs
 * .sh — and is the execution-order key within an event) is derived from the
 * event and language instead.
 */

export type HookLanguage = "python" | "shell";

export function languageFromFileName(fileName: string): HookLanguage {
  return fileName.trim().toLowerCase().endsWith(".py") ? "python" : "shell";
}

/**
 * Derive the stored file name from the event + language, uniquified against
 * the agent's other hooks on the same event ((agentId, event, fileName) is
 * unique).
 */
export function generateHookFileName(params: {
  event: string;
  language: HookLanguage;
  takenFileNames: string[];
}): string {
  const { event, language, takenFileNames } = params;
  const taken = new Set(takenFileNames.map((name) => name.toLowerCase()));
  const ext = language === "python" ? "py" : "sh";
  const base = event.replace(/_/g, "-");
  let candidate = `${base}.${ext}`;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) {
    candidate = `${base}-${i}.${ext}`;
  }
  return candidate;
}
