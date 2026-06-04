import type { archestraApiTypes } from "@shared";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

/**
 * Whether the current user can edit a catalog item: an mcpServerInstallation
 * admin, OR the author of a personal-scope catalog. Mirrors the backend's
 * authorization for catalog edits.
 */
export function useCanEditCatalogItem(
  catalog: CatalogItem | null | undefined,
): { canEdit: boolean; isLoading: boolean } {
  const { data: isAdmin, isLoading: isAdminLoading } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const { data: session, isPending: isSessionLoading } = useSession();
  const isLoading = isAdminLoading || isSessionLoading;

  if (!catalog) return { canEdit: false, isLoading };
  if (isAdmin) return { canEdit: true, isLoading };

  const currentUserId = session?.user?.id;
  const canEdit =
    !!currentUserId &&
    catalog.scope === "personal" &&
    catalog.authorId === currentUserId;
  return { canEdit, isLoading };
}
