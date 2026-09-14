import { permanentRedirect } from "next/navigation";
import { a2aRemoteAgentNewHref } from "@/lib/a2a-remote-agent-route";

export const dynamic = "force-dynamic";

export default async function NewA2aRemoteAgentPageServer() {
  permanentRedirect(a2aRemoteAgentNewHref());
}
