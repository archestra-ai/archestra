"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { LoadingWrapper } from "@/components/loading";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Button } from "@/components/ui/button";
import { useAppTools } from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { AppManageToolsDialog } from "./app-manage-tools-dialog";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];
type AssignedTool = archestraApiTypes.GetAppToolsResponses["200"][number];

export function AppEnabledTools({ appId }: { appId: string }) {
  const { data: assigned, isPending } = useAppTools(appId);
  const { data: catalogs = [] } = useInternalMcpCatalog();
  const { data: canEdit } = useHasPermissions({ app: ["update"] });
  const [manageOpen, setManageOpen] = useState(false);

  const catalogById = useMemo(
    () => new Map(catalogs.map((c) => [c.id, c])),
    [catalogs],
  );

  // Tools whose server has left the catalog fall under a null key.
  const groups = useMemo(() => {
    const map = new Map<string | null, AssignedTool[]>();
    for (const tool of assigned ?? []) {
      const key = tool.catalogId ?? null;
      const list = map.get(key);
      if (list) list.push(tool);
      else map.set(key, [tool]);
    }
    return [...map.entries()];
  }, [assigned]);

  const total = assigned?.length ?? 0;
  const serverCount = groups.length;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">
        Enabled tools
        {total > 0 ? (
          <span className="text-sm font-normal text-muted-foreground">
            {" "}
            · {total} across {serverCount} server
            {serverCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </h2>

      <LoadingWrapper isPending={isPending && !assigned} loadingFallback={null}>
        {total === 0 ? (
          <p className="pb-1 text-sm text-muted-foreground">
            No tools enabled. The app can still use its data store.
          </p>
        ) : (
          <ul className="divide-y divide-border/50 [&>li:first-child]:pt-0">
            {groups.map(([catalogId, tools], index) => (
              <EnabledToolsRow
                key={catalogId ?? `__unknown-${index}`}
                catalog={catalogId ? catalogById.get(catalogId) : undefined}
                tools={tools}
              />
            ))}
          </ul>
        )}
      </LoadingWrapper>

      {canEdit ? (
        <>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setManageOpen(true)}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Manage tools
          </Button>
          <AppManageToolsDialog
            appId={appId}
            open={manageOpen}
            onOpenChange={setManageOpen}
          />
        </>
      ) : null}
    </section>
  );
}

function EnabledToolsRow({
  catalog,
  tools,
}: {
  catalog: CatalogItem | undefined;
  tools: AssignedTool[];
}) {
  return (
    <li className="flex items-start gap-3 py-2.5 text-sm">
      <McpCatalogIcon
        icon={catalog?.icon ?? null}
        catalogId={catalog?.id ?? ""}
        size={18}
      />
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium">{catalog?.name ?? "Other tools"}</p>
        <p className="break-words font-mono text-muted-foreground">
          {tools.map((t) => t.name).join(", ")}
        </p>
      </div>
    </li>
  );
}
