import ToolPoliciesClient from "./page.client";

export default async function ToolPoliciesPage({
  params,
}: {
  params: Promise<{ toolId: string }>;
}) {
  const { toolId } = await params;
  return <ToolPoliciesClient toolId={toolId} />;
}
