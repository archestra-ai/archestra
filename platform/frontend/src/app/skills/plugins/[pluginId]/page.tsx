import { PluginSkillPage } from "./page.client";

export const dynamic = "force-dynamic";

export default async function PluginSkillPageServer({
  params,
}: {
  params: Promise<{ pluginId: string }>;
}) {
  const { pluginId } = await params;
  return <PluginSkillPage pluginId={decodeURIComponent(pluginId)} />;
}
