import ConnectorDetailPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function ConnectorDetailPageServer({
  params,
}: {
  params: Promise<{ id: string; connectorId: string }>;
}) {
  const { id, connectorId } = await params;
  return <ConnectorDetailPage knowledgeBaseId={id} connectorId={connectorId} />;
}
