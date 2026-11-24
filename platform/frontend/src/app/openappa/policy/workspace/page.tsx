import { GuardrailsPolicyEditor } from "../../guardrails-policy-editor";

// The file workspace: every policy file in an explorer beside the editor. The
// open file, a focused line and the view live in the URL's query, which the
// editor reads on the client so that switching files needs no round trip.
// Nothing links here yet, except for a reader of MCP servers' rules alone.
export default function OpenAppaPolicyWorkspacePage() {
  return <GuardrailsPolicyEditor />;
}
