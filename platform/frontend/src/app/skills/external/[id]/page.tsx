import { ExternalMcpSkillPage } from "./page.client";

export const dynamic = "force-dynamic";

export default async function ExternalMcpSkillPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ExternalMcpSkillPage id={decodeURIComponent(id)} />;
}
