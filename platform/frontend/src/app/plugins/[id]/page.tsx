import PluginDetailPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function PluginDetailPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PluginDetailPage id={decodeURIComponent(id)} />;
}
