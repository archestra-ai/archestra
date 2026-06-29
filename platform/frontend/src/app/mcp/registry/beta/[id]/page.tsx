import { McpCatalogItemPage } from "./page.client";

export default async function McpCatalogItemPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <McpCatalogItemPage id={decodeURIComponent(id)} />;
}
