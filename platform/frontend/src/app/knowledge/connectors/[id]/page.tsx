import ConnectorDetailPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ConnectorDetailPage connectorId={id} />;
}
