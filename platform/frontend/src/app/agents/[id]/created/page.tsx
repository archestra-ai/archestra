import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Preserve old creation links while sending agents directly to chat. */
export default async function AgentCreatedPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/chat?agentId=${encodeURIComponent(decodeURIComponent(id))}`);
}
