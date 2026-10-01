/** Keep a server-staged review readable without changing its exact call or scope. */
export function readableReviewQuestion(
  question: string,
  dismissible = false,
): string {
  const [top, bottom, ...rest] = question.split("\n");
  if (
    !top?.startsWith("\u2584\u2588\u2584\u2584\u2584\u2588\u2584") ||
    !bottom?.startsWith("\u2588\u2588\u2584\u2588\u2584\u2588\u2588")
  )
    return question;
  const full = rest.join("\n");
  const authority = /APPA asks you to rule as the authority "([^"]+)"\./.exec(
    full,
  )?.[1];
  const [details, scope] = full.split("\nWhat this ruling would cover:\n");
  const argumentsText = /\nTool: ([^\n]+)\nArguments:\n([\s\S]+)$/.exec(
    details,
  )?.[2];
  const requirements = scope?.split("\n\nAccept only if ")[0]?.trim();
  const clean = (value: string) =>
    value.replace(/^[\u2580\u2588\u2584 \t]+/, "").trim();
  const tool = /^([^ ]+)/.exec(clean(bottom))?.[1];
  if (authority && argumentsText && requirements && tool) {
    return [
      `Approve this ${tool} call?`,
      `Arguments:\n${argumentsText.trim()}`,
      `Authority: ${authority}`,
      `Required: ${requirements.replace(/^[- ]+/, "")}`,
      `Approve only this call. Deny blocks it and continues other reviews. ${dismissible ? "Dismiss" : "Cancel"} leaves this call unanswered.`,
    ].join("\n\n");
  }
  return [clean(top), clean(bottom), ...rest].join("\n");
}
