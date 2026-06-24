import { McpRegistryServerDetailPage } from "./page.client";

export default async function McpRegistryServerDetailPageServer({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  return <McpRegistryServerDetailPage name={decodeURIComponent(name)} />;
}
