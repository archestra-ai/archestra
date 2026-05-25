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
import { useMcpPresetEntries } from "@/lib/mcp/mcp-preset-entry.query";
import { usePresetEntityName } from "@/lib/organization.query";
import { PresetFieldInput } from "./preset-field-input";
import {
  type CatalogItem,
  compileValidationRegex,
  listCatalogFields,
  presetHasUnfilledFields,
  useCanEditCatalogPresets,
  validateFieldAgainstRegex,
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
  const { singular, defaultValidationRegex } = usePresetEntityName();
  const presetLower = singular.toLowerCase();
  const { data: children = [] } = useCatalogPresets(catalog.id);
  const { data: entries = [] } = useMcpPresetEntries();
  const updatePreset = useUpdateCatalogPreset(catalog.id);
  const updateParentCatalog = useUpdateInternalMcpCatalogItem();
  const { canEdit } = useCanEditCatalogPresets(catalog);

  const selectedPreset =
    selectedPresetId === catalog.id
      ? catalog
      : children.find((c) => c.id === selectedPresetId);

  // When the selected "preset" is actually the parent (the implicit default),
  // there's no entry — fall back to the org-wide default validation regex.
  const validationRegex = useMemo(() => {
    const isDefault = !!selectedPreset && selectedPreset.id === catalog.id;
    if (isDefault) return compileValidationRegex(defaultValidationRegex);
    const entryId =
      selectedPreset && "presetEntryId" in selectedPreset
        ? selectedPreset.presetEntryId
        : null;
    if (!entryId) return null;
    const entry = entries.find((e) => e.id === entryId);
    return compileValidationRegex(entry?.validationRegex);
  }, [entries, selectedPreset, catalog.id, defaultValidationRegex]);

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

  const fieldErrors = useMemo(() => {
    const errors: Record<string, string | null> = {};
    for (const f of unfilled) {
      errors[f.key] = validateFieldAgainstRegex({
        value: values[f.key] ?? "",
        regex: validationRegex,
        required: f.required,
        valueType: f.valueType,
        presetTerm: singular,
      });
    }
    return errors;
  }, [unfilled, values, validationRegex, singular]);

  if (!selectedPreset || unfilled.length === 0) return null;

  if (!canEdit) {
    return (
      <div className="space-y-4">
        <Alert>
          <AlertDescription>
            This MCP server isn't ready to install in the{" "}
            <span className="font-medium">{selectedPreset.name}</span>{" "}
            {presetLower} yet — some values still need to be filled in. Ask your
            administrator to finish configuring it.
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

  const isValid =
    unfilled.every((f) => {
      if (!f.required) return true;
      const v = values[f.key];
      if (f.valueType === "boolean") return v === "true" || v === "false";
      return !!v?.trim();
    }) && Object.values(fieldErrors).every((err) => !err);

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
              error={fieldErrors[f.key]}
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
              error={fieldErrors[f.key]}
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
