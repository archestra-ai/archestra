import AppRunPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function AppRunPageServer({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const { appId } = await params;
  return <AppRunPage appId={appId} />;
}
