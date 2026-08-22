import type { ErrorExtended } from "@archestra/shared";

import { ForbiddenPage } from "@/app/_parts/forbidden-page";
import { ServerErrorFallback } from "@/components/error-fallback";
import { serverCanAccessPage } from "@/lib/auth/auth.server";
import NewMcpCatalogItemPage from "./page.client";

export const dynamic = "force-dynamic";

/**
 * The route is listed in `requiredPagePermissionsMap`, which only hides it
 * from the nav. Without this guard a user who typed the URL filled the whole
 * form before the create call refused it, so the refusal is taken here,
 * before the form is offered.
 */
export default async function NewMcpCatalogItemPageServer() {
  try {
    if (!(await serverCanAccessPage("/mcp/registry/new"))) {
      return <ForbiddenPage />;
    }
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return <NewMcpCatalogItemPage />;
}
