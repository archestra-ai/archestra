import { redirect } from "next/navigation";

export default function ToolRedirectPage({
  params,
}: {
  params: { toolId: string };
}) {
  redirect(`/tools/${params.toolId}/policies`);
}
