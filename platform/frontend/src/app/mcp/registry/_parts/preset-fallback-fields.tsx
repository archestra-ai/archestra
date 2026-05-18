"use client";

import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  useCatalogPresets,
  useUpdateCatalogPreset,
  useUpdateInternalMcpCatalogItem,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { usePresetEntityName } from "@/lib/organization.query";
import { PresetFieldInput } from "./preset-field-input";
import {
  type CatalogItem,
  listCatalogFields,
  presetHasUnfilledFields,
  useCanEditCatalogPresets,
} from "./preset-helpers";

interface FillPresetFieldsStepProps {
  /** Parent catalog item. */
  catalog: CatalogItem;
  /** Currently selected preset's catalog id (parent.id for default, child.id for named preset). */
  selectedPresetId: string;
  /** Called after preset values are saved successfully — caller should advance to the install step. */
  onSaved: () => void;
  /** Called when the user cancels out of this step. */
  onCancel: () => void;
}

/**
 * Sequential step that asks the caller to fill in any preset-scoped fields the
 * selected preset doesn't yet have values for, then persists them onto the
 * preset row before the install dialog continues to its main form.
 *
 * The parent dialog should render this only when `presetHasUnfilledFields`
 * returns true; the component itself does not gate its own visibility.
 */
export function FillPresetFieldsStep({
  catalog,
  selectedPresetId,
  onSaved,
  onCancel,
}: FillPresetFieldsStepProps) {
  const { singular } = usePresetEntityName();
  const presetLower = singular.toLowerCase();
  const { data: children = [] } = useCatalogPresets(catalog.id);
  const updatePreset = useUpdateCatalogPreset(catalog.id);
  const updateParentCatalog = useUpdateInternalMcpCatalogItem();
  const { canEdit } = useCanEditCatalogPresets(catalog);

  const selectedPreset =
    selectedPresetId === catalog.id
      ? catalog
      : children.find((c) => c.id === selectedPresetId);

  const unfilled = useMemo(() => {
    if (!selectedPreset) return [];
    const presetFields = listCatalogFields(catalog).filter(
      (f) => f.scope === "preset",
    );
    const filled = selectedPreset.presetFieldValues ?? {};
    const hasStoredSecrets = selectedPreset.presetSecretId != null;
    return presetFields.filter(
      (f) => !(f.key in filled) && !(f.secret && hasStoredSecrets),
    );
  }, [catalog, selectedPreset]);

  const [values, setValues] = useState<Record<string, string>>({});

  if (!selectedPreset || unfilled.length === 0) return null;

  if (!canEdit) {
    return (
      <div className="space-y-4">
        <Alert>
          <AlertDescription>
            This {presetLower} is missing values required to install it. Ask
            someone who can edit this catalog item to fill them in.
          </AlertDescription>
        </Alert>
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  const envFields = unfilled.filter((f) => f.origin === "envVar");
  const userConfigFields = unfilled.filter((f) => f.origin === "userConfig");
  const userConfigHeader =
    userConfigFields.length > 0 && userConfigFields.every((f) => f.headerName)
      ? "Additional Headers"
      : "Connection Settings";

  const isValid = unfilled.every((f) => {
    if (!f.required) return true;
    const v = values[f.key];
    if (f.valueType === "boolean") return v === "true" || v === "false";
    return !!v?.trim();
  });

  const isEditingDefaultPreset = selectedPreset.id === catalog.id;

  const handleSave = async () => {
    const payload: Record<string, string> = {};
    for (const f of unfilled) {
      const v = values[f.key];
      if (v === undefined || v === "") continue;
      payload[f.key] = v;
    }
    if (isEditingDefaultPreset) {
      // The "default preset" is the parent catalog row itself — it has no
      // child row, so we update preset_field_values via the parent catalog
      // update endpoint instead of the children endpoint (which would 404).
      await updateParentCatalog.mutateAsync({
        id: catalog.id,
        data: { presetFieldValues: payload },
      });
    } else {
      await updatePreset.mutateAsync({
        presetId: selectedPreset.id,
        data: { presetFieldValues: payload },
      });
    }
    onSaved();
  };

  const isSaving = updatePreset.isPending || updateParentCatalog.isPending;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">
          Configure this {singular} before installing
        </h3>
        <p className="text-xs text-muted-foreground">
          This {presetLower} is missing values that every MCP server
          installation in this {presetLower} will share.
        </p>
      </div>

      {envFields.length > 0 && (
        <div className="space-y-4">
          <h4 className="text-sm font-medium">Environment Variables</h4>
          {envFields.map((f) => (
            <PresetFieldInput
              key={`envVar:${f.key}`}
              field={f}
              idPrefix="preset-fallback"
              value={values[f.key] ?? ""}
              onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
              disabled={isSaving}
            />
          ))}
        </div>
      )}

      {envFields.length > 0 && userConfigFields.length > 0 && <Separator />}

      {userConfigFields.length > 0 && (
        <div className="space-y-4">
          <h4 className="text-sm font-medium">{userConfigHeader}</h4>
          {userConfigFields.map((f) => (
            <PresetFieldInput
              key={`userConfig:${f.key}`}
              field={f}
              idPrefix="preset-fallback"
              value={values[f.key] ?? ""}
              onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
              disabled={isSaving}
            />
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSaving}
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          disabled={!isValid || isSaving}
        >
          {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
          {isSaving ? "Saving..." : "Save and continue"}
        </Button>
      </div>
    </div>
  );
}

export { presetHasUnfilledFields };
