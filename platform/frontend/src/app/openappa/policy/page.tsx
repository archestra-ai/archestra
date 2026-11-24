import { PolicyPage } from "./page.client";

export default async function OpenAppaPolicyPage({
  searchParams,
}: {
  searchParams: Promise<{ entry?: string; line?: string }>;
}) {
  const { entry, line } = await searchParams;
  const focusLine = Number(line);
  return (
    <PolicyPage
      sourceEntry={entry}
      focusLine={
        Number.isSafeInteger(focusLine) && focusLine > 0 ? focusLine : undefined
      }
    />
  );
}
