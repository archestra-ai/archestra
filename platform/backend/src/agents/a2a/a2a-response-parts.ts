import type { UIMessage } from "ai";
import type { A2AProtocolPart } from "./a2a-protocol";

/** The final response excludes commentary from earlier tool execution steps. */
export function extractProtocolPartsFromUIMessage(
  message: UIMessage,
): A2AProtocolPart[] {
  const lastStep = message.parts.findLastIndex(
    (part) => part.type === "step-start",
  );
  return message.parts
    .slice(Math.max(0, lastStep))
    .flatMap((part) => (part.type === "text" ? [{ text: part.text }] : []));
}
