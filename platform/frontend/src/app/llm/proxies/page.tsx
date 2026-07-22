import { ForbiddenPage } from "@/app/_parts/forbidden-page";
import { serverCanAccessPage } from "@/lib/auth/auth.server";
import LlmProxyWorkspacePage from "./page.client";

export const dynamic = "force-dynamic";

export default async function LlmProxyWorkspacePageServer() {
  if (!(await serverCanAccessPage("/llm/proxies"))) {
    return <ForbiddenPage />;
  }
  return <LlmProxyWorkspacePage />;
}
