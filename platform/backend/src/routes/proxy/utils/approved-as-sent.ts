import { policyView } from "@/openappa/result-view";

/**
 * OpenAPPA reads a structured tool result (content blocks, parts, a JSON
 * object) as the JSON text of its policy view: what the client sent, with the
 * payload of each binary part replaced by a marker. It answers with the output
 * it approved. An output that is that same text means the result was kept as
 * sent, so the adapter forwards the client's own structure, bytes included: an
 * image stays an image block. Any other output replaces the result with its
 * text, and no binary payload is forwarded.
 *
 * A decision stored before the policy view existed holds the JSON of the full
 * result. That text counts as kept too.
 */
export function isApprovedAsSent(params: {
  sent: unknown;
  approved: string;
}): boolean {
  const { sent, approved } = params;
  return (
    typeof sent === "object" &&
    sent !== null &&
    (approved === JSON.stringify(policyView(sent)) ||
      // A result approved before binary parts were replaced by markers: the
      // runtime approved the full JSON, bytes included.
      approved === JSON.stringify(sent))
  );
}
