"use client";

import { Plus, Server } from "lucide-react";
import { useMemo, useState } from "react";
import { CreateCatalogDialog } from "@/app/mcp/registry/_parts/create-catalog-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import { CatalogDetailDialog } from "./_parts/catalog-detail-dialog";
import type { CatalogItem } from "./_parts/types";

export default function RegistryV3ListPage() {
  const { data: catalogs = [] } = useInternalMcpCatalog();
  const { data: servers = [] } = useMcpServers();
  const [openCat, setOpenCat] = useState<CatalogItem | null>(null);
  const [creating, setCreating] = useState(false);

  const enriched = useMemo(
    () =>
      catalogs.map((c) => ({
        cat: c,
        installCount: servers.filter((s) => s.catalogId === c.id).length,
      })),
    [catalogs, servers],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {catalogs.length}{" "}
          {catalogs.length === 1 ? "catalog item" : "catalog items"}
        </p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          Add MCP Server
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {enriched.map(({ cat, installCount }) => (
          <Card
            key={cat.id}
            className="flex h-full cursor-pointer flex-col gap-4 pt-4 transition-colors hover:border-primary/40"
            onClick={() => setOpenCat(cat)}
          >
            <CardHeader className="gap-0">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="rounded bg-muted p-1.5">
                    <Server className="h-4 w-4" />
                  </div>
                  <span className="truncate text-lg font-semibold">
                    {cat.name}
                  </span>
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {cat.multitenant ? "Multi-tenant" : "Single-tenant"} ·{" "}
                {cat.serverType}
              </p>
            </CardHeader>
            <CardContent className="flex flex-grow flex-col gap-4">
              <div className="mt-auto space-y-3">
                {cat.labels && cat.labels.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {cat.labels.map((l) => (
                      <Badge
                        key={`${l.key}=${l.value}`}
                        variant="outline"
                        className="text-[10px] font-normal"
                      >
                        {l.key}={l.value}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="border-t pt-3 text-sm text-muted-foreground">
                  {installCount} {installCount === 1 ? "install" : "installs"}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <CatalogDetailDialog
        cat={openCat}
        open={openCat !== null}
        onOpenChange={(v) => !v && setOpenCat(null)}
      />

      <CreateCatalogDialog
        isOpen={creating}
        onClose={() => setCreating(false)}
      />
    </div>
  );
}
