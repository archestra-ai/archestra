import { permanentRedirect } from "next/navigation";
import { a2aRemoteAgentDetailHref } from "@/lib/a2a-remote-agent-route";

export const dynamic = "force-dynamic";

export default async function A2aRemoteAgentDetailPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  permanentRedirect(a2aRemoteAgentDetailHref(id));
}
