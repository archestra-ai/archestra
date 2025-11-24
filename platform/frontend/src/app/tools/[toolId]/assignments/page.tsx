import ToolAssignmentsClient from "./page.client";

export default async function ToolAssignmentsPage({
  params,
}: {
  params: Promise<{ toolId: string }>;
}) {
  const { toolId } = await params;
  return <ToolAssignmentsClient toolId={toolId} />;
}
