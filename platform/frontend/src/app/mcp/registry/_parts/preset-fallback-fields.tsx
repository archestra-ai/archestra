"use client";

import { Separator } from "@/components/ui/separator";
import { useCatalogPresets } from "@/lib/mcp/internal-mcp-catalog.query";
import { PresetFieldInput } from "./preset-field-input";
import { type CatalogItem, listCatalogFields } from "./preset-helpers";

interface PresetFallbackFieldsProps {
  /** Parent catalog item. */
  catalog: CatalogItem;
  /** Currently selected preset's catalog id (parent.id for default, child.id for named preset). */
  selectedPresetId: string;
  /** Map of field-key → user-entered value. */
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}

/**
 * Renders inputs for any preset-scoped field that the selected preset
 * doesn't have a value for. Returns null if the catalog has no
 * preset-scoped fields or the selected preset fills them all.
 */
export function PresetFallbackFields({
  catalog,
  selectedPresetId,
  values,
  onChange,
}: PresetFallbackFieldsProps) {
  const { data: children = [] } = useCatalogPresets(catalog.id);

  const selectedPreset =
    selectedPresetId === catalog.id
      ? catalog
      : children.find((c) => c.id === selectedPresetId);

  if (!selectedPreset) return null;

  const presetFields = listCatalogFields(catalog).filter(
    (f) => f.scope === "preset",
  );
  const filled = selectedPreset.presetFieldValues ?? {};
  const hasStoredSecrets = selectedPreset.presetSecretId != null;
  const unfilled = presetFields.filter(
    (f) => !(f.key in filled) && !(f.secret && hasStoredSecrets),
  );

  if (unfilled.length === 0) return null;

  const envFields = unfilled.filter((f) => f.origin === "envVar");
  const userConfigFields = unfilled.filter((f) => f.origin === "userConfig");
  const userConfigHeader =
    userConfigFields.length > 0 && userConfigFields.every((f) => f.headerName)
      ? "Additional Headers"
      : "Connection Settings";

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Preset fields not filled
        </h3>
        <p className="text-xs text-muted-foreground">
          The selected preset doesn't set these. Fill them for this install, or
          set them once on the preset.
        </p>
      </div>

      {envFields.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-sm font-medium">Environment Variables</h3>
          {envFields.map((f) => (
            <PresetFieldInput
              key={`envVar:${f.key}`}
              field={f}
              idPrefix="preset-fallback"
              value={values[f.key] ?? ""}
              onChange={(v) => onChange(f.key, v)}
            />
          ))}
        </div>
      )}

      {envFields.length > 0 && userConfigFields.length > 0 && <Separator />}

      {userConfigFields.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-sm font-medium">{userConfigHeader}</h3>
          {userConfigFields.map((f) => (
            <PresetFieldInput
              key={`userConfig:${f.key}`}
              field={f}
              idPrefix="preset-fallback"
              value={values[f.key] ?? ""}
              onChange={(v) => onChange(f.key, v)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Collect non-empty preset-scoped values from the install dialog's fallback
 * map. Returns a flat key→value record suitable for the install POST's
 * `presetFieldValues` field — the backend partitions secrets and persists
 * them on the targeted preset row, mirroring the preset editor's behavior.
 */
export function collectPresetFallbackValues(
  catalog: CatalogItem,
  values: Record<string, string>,
): Record<string, string> {
  const presetFields = listCatalogFields(catalog).filter(
    (f) => f.scope === "preset",
  );
  const presetKeys = new Set(presetFields.map((f) => f.key));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    if (!presetKeys.has(key)) continue;
    result[key] = value;
  }
  return result;
}
