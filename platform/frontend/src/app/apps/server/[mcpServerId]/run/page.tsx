import ServerAppRunPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function ServerAppRunPageServer({
  params,
}: {
  params: Promise<{ mcpServerId: string }>;
}) {
  const { mcpServerId } = await params;
  return <ServerAppRunPage mcpServerId={mcpServerId} />;
}
