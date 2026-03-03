import KnowledgeBaseDetailPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function KnowledgeBaseDetailPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <KnowledgeBaseDetailPage id={id} />;
}
