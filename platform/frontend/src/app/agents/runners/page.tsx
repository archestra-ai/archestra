import { ForbiddenPage } from "@/app/_parts/forbidden-page";
import RunnersPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function RunnersPageServer() {
  const { serverCanAccessPage } = await import("@/lib/auth/auth.server");
  if (!(await serverCanAccessPage("/agents/runners"))) {
    return <ForbiddenPage />;
  }
  return <RunnersPage />;
}
