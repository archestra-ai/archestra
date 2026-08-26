import { RunnerDetailClient } from "./page.client";

export default async function RunnerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <RunnerDetailClient runnerId={id} />;
}
