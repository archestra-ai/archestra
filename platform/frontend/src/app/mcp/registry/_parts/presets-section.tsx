"use client";

import type { archestraApiTypes } from "@shared";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useCatalogPresets,
  useDeleteCatalogPreset,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { PresetEditorDialog } from "./preset-editor-dialog";
import {
  type CatalogItem,
  listCatalogFields,
  presetFieldKeys,
} from "./preset-helpers";

type Preset = archestraApiTypes.GetCatalogChildrenResponses["200"][number];

interface PresetsSectionProps {
  cat: CatalogItem;
}

export function PresetsSection({ cat }: PresetsSectionProps) {
  const { data: children = [], isLoading } = useCatalogPresets(cat.id);
  const deletePreset = useDeleteCatalogPreset(cat.id);
  const [editing, setEditing] = useState<Preset | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Preset | null>(null);

  const fieldKeys = presetFieldKeys(cat);
  const presetFields = listCatalogFields(cat).filter(
    (f) => f.scope === "preset",
  );

  const rows: Array<{ entry: Preset; isDefault: boolean }> = [
    { entry: cat as Preset, isDefault: true },
    ...children.map((c) => ({ entry: c, isDefault: false })),
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">
            {rows.length} {rows.length === 1 ? "preset" : "presets"}
          </h3>
          <p className="text-xs text-muted-foreground">
            {fieldKeys.length === 0
              ? "This catalog has no preset-scoped fields. Mark fields with promptOnPreset in Configuration to vary them per preset."
              : `Preset fields: ${fieldKeys.join(", ")}`}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setCreating(true)}
          disabled={fieldKeys.length === 0}
        >
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
                    {formatFieldValues(entry, presetFields)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
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
                        disabled={isDefault}
                        onClick={() => setDeleteTarget(entry)}
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
      <DeleteConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="Delete preset"
        description={
          deleteTarget ? (
            <span>
              Are you sure you want to delete preset{" "}
              <span className="font-mono font-semibold">
                {deleteTarget.name}
              </span>
              ? Servers installed from this preset will be uninstalled.
            </span>
          ) : (
            ""
          )
        }
        isPending={deletePreset.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return;
          await deletePreset.mutateAsync(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}

function formatVal(v: string | number | boolean | string[]): string {
  if (Array.isArray(v)) return v.join("|");
  return String(v);
}

/**
 * Render the `Field values` column for a preset row. Iterates the parent's
 * declared preset-scoped fields so the order is stable and secret values are
 * never sourced from the wire payload — secret fields show "set" / "unset"
 * based on the `presetSecretId != null` heuristic, matching how the install
 * dialog's preset-fallback section decides whether to re-prompt.
 */
function formatFieldValues(
  entry: Preset,
  presetFields: ReturnType<typeof listCatalogFields>,
): string {
  if (presetFields.length === 0) return "—";
  const filled = entry.presetFieldValues ?? {};
  const hasStoredSecrets = entry.presetSecretId != null;
  const parts: string[] = [];
  for (const f of presetFields) {
    if (f.secret) {
      if (hasStoredSecrets) parts.push(`${f.key}=<set>`);
    } else if (f.key in filled) {
      parts.push(`${f.key}=${formatVal(filled[f.key])}`);
    }
  }
  return parts.length === 0 ? "—" : parts.join(", ");
}
