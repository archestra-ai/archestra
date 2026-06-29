import { McpCatalogItemEditPage } from "./page.client";

export default async function McpCatalogItemEditPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <McpCatalogItemEditPage id={decodeURIComponent(id)} />;
}
