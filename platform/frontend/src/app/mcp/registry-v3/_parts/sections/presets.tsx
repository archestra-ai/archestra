"use client";

import { Download, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useCatalogPresets,
  useDeleteCatalogPreset,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { InstallDialog } from "../install-dialog";
import { PresetEditorDialog } from "../preset-editor-dialog";
import { type CatalogItem, listCatalogFields, type Preset } from "../types";

export function PresetsSection({ cat }: { cat: CatalogItem }) {
  const { data: children = [], isLoading } = useCatalogPresets(cat.id);
  const deletePreset = useDeleteCatalogPreset(cat.id);
  const [editing, setEditing] = useState<Preset | null>(null);
  const [creating, setCreating] = useState(false);
  const [installPresetId, setInstallPresetId] = useState<string | null>(null);

  const presetFieldKeys = listCatalogFields(cat)
    .filter((f) => f.scope === "preset")
    .map((f) => f.key);

  // Parent is the default preset. Render `[parent, ...children]` so admins
  // can edit default-preset values on the parent row directly.
  const rows: Array<{ entry: Preset; isDefault: boolean }> = [
    { entry: cat as Preset, isDefault: true },
    ...children.map((c) => ({ entry: c, isDefault: false })),
  ];
  const totalPresets = rows.length;

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">
            {totalPresets} {totalPresets === 1 ? "preset" : "presets"}
          </h3>
          <p className="text-xs text-muted-foreground">
            {presetFieldKeys.length === 0
              ? "This catalog has no preset-scoped fields. Mark fields with promptOnPreset to vary them per preset."
              : `Preset fields: ${presetFieldKeys.join(", ")}`}
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          New preset
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">Default</th>
                <th className="px-3 py-2 text-left font-medium">
                  Field values
                </th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ entry, isDefault }) => (
                <tr key={entry.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{entry.name}</td>
                  <td className="px-3 py-2">
                    {isDefault && (
                      <Badge variant="outline" className="text-[10px]">
                        default
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                    {Object.keys(entry.presetFieldValues).length === 0
                      ? "—"
                      : Object.entries(entry.presetFieldValues)
                          .map(([k, v]) => `${k}=${formatVal(v)}`)
                          .join(", ")}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2"
                        onClick={() => setInstallPresetId(entry.id)}
                      >
                        <Download className="h-3.5 w-3.5" />
                        Install
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setEditing(entry)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        disabled={isDefault || deletePreset.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete preset "${entry.name}"? This will also delete its installs.`,
                            )
                          ) {
                            deletePreset.mutate(entry.id);
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PresetEditorDialog
        cat={cat}
        preset={editing}
        open={editing !== null}
        onOpenChange={(v) => !v && setEditing(null)}
      />
      <PresetEditorDialog
        cat={cat}
        preset={null}
        open={creating}
        onOpenChange={setCreating}
      />
      <InstallDialog
        cat={cat}
        open={installPresetId !== null}
        onOpenChange={(v) => !v && setInstallPresetId(null)}
        defaultPresetId={installPresetId ?? undefined}
      />
    </div>
  );
}

function formatVal(v: string | number | boolean | string[]): string {
  if (Array.isArray(v)) return v.join("|");
  return String(v);
}
