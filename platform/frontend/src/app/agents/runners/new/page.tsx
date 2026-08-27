import { ForbiddenPage } from "@/app/_parts/forbidden-page";
import { serverCanAccessPage } from "@/lib/auth/auth.server";
import NewRunnerPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function NewRunnerPageServer() {
  if (!(await serverCanAccessPage("/agents/runners/new"))) {
    return <ForbiddenPage />;
  }
  return <NewRunnerPage />;
}
