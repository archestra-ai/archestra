"use client";

import type { archestraApiTypes } from "@shared";
import { Pencil, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useCatalogPresets } from "@/lib/mcp/internal-mcp-catalog.query";
import {
  type McpPresetEntryWithAssignedCount,
  useMcpPresetEntries,
} from "@/lib/mcp/mcp-preset-entry.query";
import { usePresetEntityName } from "@/lib/organization.query";
import { PresetEditorDialog } from "./preset-editor-dialog";
import {
  type CatalogItem,
  listCatalogFields,
  presetFieldKeys,
} from "./preset-helpers";

type Preset = archestraApiTypes.GetCatalogChildrenResponses["200"][number];

interface PresetsSectionProps {
  cat: CatalogItem;
  onGoToConfiguration?: () => void;
}

interface Row {
  rowId: string;
  displayName: string;
  isDefault: boolean;
  /** The persisted child catalog row, if this entry has been configured. */
  child: Preset | null;
  /** The org-level entry that this row represents. Null for the default row. */
  entry: McpPresetEntryWithAssignedCount | null;
}

export function PresetsSection({
  cat,
  onGoToConfiguration,
}: PresetsSectionProps) {
  const { data: children = [], isLoading: childrenLoading } = useCatalogPresets(
    cat.id,
  );
  const { data: entries = [], isLoading: entriesLoading } =
    useMcpPresetEntries();
  const { singular } = usePresetEntityName();

  const [editTarget, setEditTarget] = useState<{
    preset: Preset | null;
    entry: McpPresetEntryWithAssignedCount | null;
  } | null>(null);

  const fieldKeys = presetFieldKeys(cat);
  const presetFields = listCatalogFields(cat).filter(
    (f) => f.scope === "preset",
  );
  const childByEntryId = new Map<string, Preset>();
  for (const c of children) {
    if (c.presetEntryId) childByEntryId.set(c.presetEntryId, c);
  }

  const rows: Row[] = [
    {
      rowId: cat.id,
      displayName: "Default",
      isDefault: true,
      child: cat as unknown as Preset,
      entry: null,
    },
    ...entries.map((entry) => ({
      rowId: entry.id,
      displayName: entry.name,
      isDefault: false,
      child: childByEntryId.get(entry.id) ?? null,
      entry,
    })),
  ];

  const isLoading = childrenLoading || entriesLoading;
  const hasFields = fieldKeys.length > 0;

  return (
    <div className="space-y-4">
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !hasFields ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SlidersHorizontal />
            </EmptyMedia>
            <EmptyTitle>No preset fields configured</EmptyTitle>
            <EmptyDescription>
              {`To vary settings per ${singular}, add a ${singular}-scoped env variable or header in the Configuration tab.`}
            </EmptyDescription>
          </EmptyHeader>
          {onGoToConfiguration && (
            <EmptyContent>
              <Button variant="outline" onClick={onGoToConfiguration}>
                Go to Configuration
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <div className="rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">
                  Field values
                </th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const valueDisplay = row.child
                  ? formatFieldValues(row.child, presetFields)
                  : "—";
                const hasValues = valueDisplay !== "—";
                const isConfigured = row.isDefault
                  ? hasValues
                  : row.child !== null;
                return (
                  <tr key={row.rowId} className="border-t">
                    <td className="px-3 py-2 font-medium">{row.displayName}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {isConfigured ? "Set" : "Not set"}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                      {valueDisplay}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        variant={isConfigured ? "ghost" : "outline"}
                        size={isConfigured ? "icon" : "sm"}
                        className={isConfigured ? "h-7 w-7" : ""}
                        disabled={!hasFields}
                        onClick={() =>
                          setEditTarget({
                            preset: row.child,
                            entry: row.entry,
                          })
                        }
                        aria-label={isConfigured ? "Edit values" : "Configure"}
                      >
                        {isConfigured ? (
                          <Pencil className="h-3.5 w-3.5" />
                        ) : (
                          "Configure"
                        )}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <PresetEditorDialog
        cat={cat}
        preset={editTarget?.preset ?? null}
        entry={editTarget?.entry ?? null}
        open={editTarget !== null}
        onOpenChange={(v) => !v && setEditTarget(null)}
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
