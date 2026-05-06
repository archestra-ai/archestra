"use client";

import { Plus, Server, User, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { DeploymentStatusDot } from "@/app/mcp/registry/_parts/deployment-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CatalogDetailDialog } from "./_parts/catalog-detail-dialog";
import {
  envHealth,
  envsForCatalog,
  podsForCatalog,
  podsRunning,
  tenancyLabel,
} from "./_parts/utils";
import { useSpikeStore } from "./_seed/store";
import type { CatalogItem } from "./_seed/types";

export default function RegistryListPage() {
  const { catalogItems, environments, credentials, pods } = useSpikeStore();
  const [openCat, setOpenCat] = useState<CatalogItem | null>(null);

  const enriched = useMemo(
    () =>
      catalogItems.map((c) => {
        const envs = envsForCatalog(environments, c.id);
        const cpods = podsForCatalog(pods, c.id);
        const callers = credentials.filter((cred) => {
          const env = environments.find((e) => e.id === cred.environmentId);
          return env?.catalogId === c.id;
        }).length;
        return {
          cat: c,
          envCount: envs.length,
          callers,
          podCount: cpods.length,
          running: podsRunning(cpods),
          health: envHealth(cpods.map((p) => p.status)),
        };
      }),
    [catalogItems, environments, credentials, pods],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {catalogItems.length}{" "}
          {catalogItems.length === 1 ? "catalog item" : "catalog items"}
        </p>
        <Button size="sm">
          <Plus className="h-4 w-4" />
          Add MCP Server
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {enriched.map(
          ({ cat, envCount, callers, podCount, running, health }) => (
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
                  {tenancyLabel(cat)} · {cat.transport}
                </p>
              </CardHeader>
              <CardContent className="flex flex-grow flex-col gap-4">
                <div className="mt-auto space-y-3">
                  {cat.labels.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {cat.labels.map((l) => (
                        <Badge
                          key={l}
                          variant="outline"
                          className="text-[10px] font-normal"
                        >
                          {l}
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-3 border-t pt-3 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      {podCount > 0 ? (
                        <DeploymentStatusDot state={health} />
                      ) : (
                        <span className="inline-block h-2 w-2 rounded-full bg-muted" />
                      )}
                      {running}/{podCount}
                    </div>
                    <div className="h-4 w-px bg-border" />
                    <div className="flex items-center gap-1">
                      <Wrench className="h-3.5 w-3.5" />
                      {envCount} {envCount === 1 ? "env" : "envs"}
                    </div>
                    <div className="h-4 w-px bg-border" />
                    <div className="flex items-center gap-1">
                      <User className="h-3.5 w-3.5" />
                      {callers}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ),
        )}
      </div>

      <CatalogDetailDialog
        cat={openCat}
        open={openCat !== null}
        onOpenChange={(v) => !v && setOpenCat(null)}
      />
    </div>
  );
}
