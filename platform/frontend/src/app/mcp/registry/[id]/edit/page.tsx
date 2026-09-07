import { isPlaywrightCatalogItem } from "@archestra/shared";
import { redirect } from "next/navigation";
import { McpCatalogItemEditPage } from "./page.client";

export default async function McpCatalogItemEditPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const catalogId = decodeURIComponent(id);
  if (isPlaywrightCatalogItem(catalogId)) {
    redirect(`/mcp/registry/${catalogId}`);
  }
  return <McpCatalogItemEditPage id={catalogId} />;
}
