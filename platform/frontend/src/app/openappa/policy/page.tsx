import { GuardrailsPolicyEditor } from "../guardrails-policy-editor";

// The open file, a focused line and the view live in the URL's query, which
// the editor reads on the client so that switching files needs no round trip.
export default function OpenAppaPolicyPage() {
  return <GuardrailsPolicyEditor />;
}
