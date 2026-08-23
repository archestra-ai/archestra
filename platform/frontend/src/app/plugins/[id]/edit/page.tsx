import { PluginEditPage } from "./page.client";

export const dynamic = "force-dynamic";

export default async function PluginEditPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PluginEditPage id={decodeURIComponent(id)} />;
}
