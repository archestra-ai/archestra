import type { OpenAppaYell } from "@/lib/openappa-yells.query";

/** Keep waiver mechanics in the report; lead the row with the specific cause. */
export function yellSummary(yell: Pick<OpenAppaYell, "kind" | "message">) {
  const fallback = yell.message.replace(/\s+/g, " ").trim();
  if (yell.kind === "agent") return fallback;
  const refusal = yell.message.match(
    /(?:^|\n)Original refusal:\n([\s\S]*?)(?=\n\nResult:|$)/,
  )?.[1];
  if (!refusal?.trim()) return fallback;

  // Wrapped native failures put the useful explanation after the generic error.
  const cause = refusal.split("\nCaused by: ").at(-1)?.trim() ?? refusal;
  const why = cause.match(/(?:^|\n)Why:\s*\n\s*-\s*([^\n]+)/)?.[1];
  const reason = (why ?? cause)
    .replace(/^\[appa\]\s*/, "")
    .replace(/^OpenAPPA processing interrupted:\s*/, "")
    .split(/\n/)[0]
    .split(/[.!?](?:\s|$)/)[0]
    .trim();
  if (!reason) return fallback;

  const tools = yell.message.match(/^Affected tools: (.+)\.\n/)?.[1];
  return tools &&
    tools !== "Not attributed (session operation)" &&
    !reason.toLowerCase().includes(tools.toLowerCase())
    ? `${tools}: ${reason}`
    : reason;
}
