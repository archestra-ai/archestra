"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCatalogPresets } from "@/lib/mcp/internal-mcp-catalog.query";
import { useDeleteMcpServer, useMcpServers } from "@/lib/mcp/mcp-server.query";
import { InstallDialog } from "../install-dialog";
import type { CatalogItem } from "../types";

export function CredentialsSection({ cat }: { cat: CatalogItem }) {
  const { data: servers = [], isLoading } = useMcpServers({
    catalogId: cat.id,
  });
  const { data: children = [] } = useCatalogPresets(cat.id);
  const deleteServer = useDeleteMcpServer();
  const [installing, setInstalling] = useState(false);

  // Each install's `catalogId` points either at the parent (= default preset)
  // or at a child catalog row. Build a lookup that handles both.
  const presetById = new Map<string, { name: string; isDefault: boolean }>([
    [cat.id, { name: cat.name, isDefault: true }],
    ...children.map((c) => [c.id, { name: c.name, isDefault: false }] as const),
  ]);

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">
            {servers.length}{" "}
            {servers.length === 1 ? "credential" : "credentials"}
          </h3>
          <p className="text-xs text-muted-foreground">
            Each row is one mcp_server install: a caller (or team/org) bound to
            a preset of this catalog.
          </p>
        </div>
        <Button size="sm" onClick={() => setInstalling(true)}>
          <Plus className="h-4 w-4" />
          Install
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No credentials yet. Install this catalog for a caller, team, or org to
          create one.
        </p>
      ) : (
        <div className="rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">Scope</th>
                <th className="px-3 py-2 text-left font-medium">Preset</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => {
                const preset = presetById.get(s.catalogId ?? "");
                return (
                  <tr key={s.id} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs">{s.name}</td>
                    <td className="px-3 py-2 text-xs">{s.scope}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {preset?.name ?? "—"}
                      {preset?.isDefault && (
                        <Badge variant="outline" className="ml-1.5 text-[9px]">
                          default
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {s.localInstallationStatus ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        disabled={deleteServer.isPending}
                        onClick={() => {
                          if (window.confirm(`Uninstall "${s.name}"?`)) {
                            deleteServer.mutate({ id: s.id, name: s.name });
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <InstallDialog cat={cat} open={installing} onOpenChange={setInstalling} />
    </div>
  );
}
