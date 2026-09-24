import { GuardrailsPolicyEditor } from "../guardrails-policy-editor";

export default async function OpenAppaPolicyPage({
  searchParams,
}: {
  searchParams: Promise<{ entry?: string; line?: string }>;
}) {
  const { entry, line } = await searchParams;
  const focusLine = Number(line);
  return (
    <GuardrailsPolicyEditor
      readOnly
      sourceEntry={entry}
      focusLine={
        Number.isSafeInteger(focusLine) && focusLine > 0 ? focusLine : undefined
      }
    />
  );
}
