"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { DeploymentStatusDot } from "@/app/mcp/registry/_parts/deployment-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useSpikeStore } from "../../_seed/store";
import type { CatalogItem, Environment } from "../../_seed/types";
import { EnvironmentEditorDialog } from "../environment-editor-dialog";
import { envHealth, fmtDate } from "../utils";

export function EnvironmentsSection({ catalogId }: { catalogId: string }) {
  const { catalogItems, environments, credentials, pods, deleteEnvironment } =
    useSpikeStore();
  const cat = catalogItems.find((c) => c.id === catalogId);
  const envs = environments.filter((e) => e.catalogId === catalogId);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Environment | null>(null);

  if (!cat) return null;

  function openNew() {
    setEditing(null);
    setEditorOpen(true);
  }

  function openEdit(env: Environment) {
    setEditing(env);
    setEditorOpen(true);
  }

  return (
    <div className="space-y-4 px-4 py-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          Named parameter sets against this catalog item. Each environment can
          be installed independently.
        </p>
        <Button size="sm" onClick={openNew}>
          <Plus className="h-4 w-4" />
          New environment
        </Button>
      </div>
      <div className="space-y-3">
        {envs.map((e) => {
          const callers = credentials.filter(
            (c) => c.environmentId === e.id,
          ).length;
          const epods = pods.filter((p) => p.environmentId === e.id);
          const health = envHealth(epods.map((p) => p.status));
          return (
            <Card key={e.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-sm font-semibold">{e.label}</span>
                      {e.isDefault && (
                        <Badge variant="outline" className="text-[10px]">
                          default
                        </Badge>
                      )}
                      {e.visibility.kind === "org" ? (
                        <Badge variant="secondary" className="text-[10px]">
                          org-wide
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">
                          team: {e.visibility.teamName}
                        </Badge>
                      )}
                    </div>
                    {Object.keys(e.fieldValues).length > 0 ? (
                      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-3">
                        {Object.entries(e.fieldValues).map(([k, v]) => (
                          <div key={k} className="flex gap-2">
                            <span className="font-mono text-muted-foreground">
                              {k}
                            </span>
                            <span className="font-mono">=</span>
                            <span className="truncate font-mono">
                              {String(v)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        No environment field values.
                      </div>
                    )}
                    <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
                      <span>
                        <span className="font-medium text-foreground">
                          {callers}
                        </span>{" "}
                        callers
                      </span>
                      <span>·</span>
                      <span>
                        <span className="font-medium text-foreground">
                          {epods.length}
                        </span>{" "}
                        {epods.length === 1 ? "pod" : "pods"}
                      </span>
                      <span>·</span>
                      <span className="flex items-center gap-1.5">
                        {epods.length > 0 ? (
                          <DeploymentStatusDot state={health} />
                        ) : (
                          <span className="inline-block h-2 w-2 rounded-full bg-muted" />
                        )}
                        {epods.length === 0
                          ? "no pods"
                          : health === "running"
                            ? "up"
                            : health}
                      </span>
                      <span>·</span>
                      <span>created {fmtDate(e.createdAt)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEdit(e)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => deleteEnvironment(e.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <EnvironmentEditorDialog
        cat={cat as CatalogItem}
        env={editing}
        open={editorOpen}
        onOpenChange={(v) => {
          setEditorOpen(v);
          if (!v) setEditing(null);
        }}
      />
    </div>
  );
}
