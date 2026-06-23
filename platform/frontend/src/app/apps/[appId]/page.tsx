import AppDetailPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function AppDetailPageServer({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const { appId } = await params;
  return <AppDetailPage appId={appId} />;
}
