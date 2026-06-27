import CatalogAppRunPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function CatalogAppRunPageServer({
  params,
}: {
  params: Promise<{ catalogId: string }>;
}) {
  const { catalogId } = await params;
  return <CatalogAppRunPage catalogId={catalogId} />;
}
