import { ForbiddenPage } from "@/app/_parts/forbidden-page";
import { serverCanAccessPage } from "@/lib/auth/auth.server";
import OutboundA2aAgentsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function OutboundA2aAgentsPageServer() {
  if (!(await serverCanAccessPage("/a2a/agents"))) {
    return <ForbiddenPage />;
  }
  return <OutboundA2aAgentsPage />;
}
