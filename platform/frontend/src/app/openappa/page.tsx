import { OpenAppaOverview } from "./_parts/openappa-overview";

export default async function OpenAppaPage({
  searchParams,
}: {
  searchParams: Promise<{ start?: string }>;
}) {
  const { start } = await searchParams;
  const initialPrompt =
    start === "review"
      ? "Review my current OpenAPPA policy. Explain what it does, then suggest one useful improvement. Do not change it yet."
      : undefined;
  return <OpenAppaOverview initialPrompt={initialPrompt} />;
}
