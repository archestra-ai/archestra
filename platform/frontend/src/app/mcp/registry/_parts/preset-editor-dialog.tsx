"use client";

import type { archestraApiTypes } from "@shared";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  useCatalogPresets,
  useCreateCatalogPreset,
  useUpdateCatalogPreset,
  useUpdateInternalMcpCatalogItem,
} from "@/lib/mcp/internal-mcp-catalog.query";
import type { McpPresetEntryWithAssignedCount } from "@/lib/mcp/mcp-preset-entry.query";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import { usePresetEntityName } from "@/lib/organization.query";
import { PresetFieldInput } from "./preset-field-input";
import {
  type CatalogFieldEntry,
  type CatalogItem,
  listCatalogFields,
} from "./preset-helpers";
import { ReinstallConfirmBar } from "./reinstall-confirm-bar";

type FieldValue = string | number | boolean | string[];
type Preset = archestraApiTypes.GetCatalogChildrenResponses["200"][number];

interface PresetEditorDialogProps {
  cat: CatalogItem;
  /**
   * The existing per-catalog row to edit. Null while configuring an org entry
   * for the first time (in which case `entry` must be provided).
   */
  preset: Preset | null;
  /**
   * The org-level entry being configured. Required when `preset` is null
   * (create mode). Ignored when editing the parent's default row.
   */
  entry?: McpPresetEntryWithAssignedCount | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function PresetEditorDialog({
  cat,
  preset,
  entry,
  open,
  onOpenChange,
}: PresetEditorDialogProps) {
  const isEdit = preset !== null;
  const isEditingDefaultPreset = preset !== null && preset.id === cat.id;
  const presetEntityName = usePresetEntityName();
  const { singular } = presetEntityName;

  const presetFields = listCatalogFields(cat).filter(
    (f) => f.scope === "preset",
  );

  const create = useCreateCatalogPreset(cat.id);
  const update = useUpdateCatalogPreset(cat.id);
  const updateParent = useUpdateInternalMcpCatalogItem();

  // Count installs that the backend's `cascadeReinstallForCatalog` will
  // touch. For default-preset edits the parent PUT cascades to the parent
  // itself AND iterates each child preset; for child edits only that
  // child's installs are affected. Preset value changes never trigger
  // `requiresNewUserInputForReinstall` on the backend, so they always
  // take the auto-reinstall path (pods restart immediately).
  const { data: childPresets = [] } = useCatalogPresets(cat.id);
  const { data: allServers = [] } = useMcpServers();
  const affectedCatalogIds = useMemo(() => {
    if (!isEdit || !preset) return new Set<string>();
    if (isEditingDefaultPreset) {
      return new Set<string>([cat.id, ...childPresets.map((p) => p.id)]);
    }
    return new Set<string>([preset.id]);
  }, [isEdit, preset, isEditingDefaultPreset, cat.id, childPresets]);
  const affectedServerCount = useMemo(
    () =>
      allServers.filter(
        (s) => s.catalogId && affectedCatalogIds.has(s.catalogId),
      ).length,
    [allServers, affectedCatalogIds],
  );
  // "across N presets" suffix only makes sense when the edit spans more
  // than one preset (default-preset edit). For a child edit the user
  // already knows which preset they're editing from the dialog title.
  const otherPresetCount = isEditingDefaultPreset ? childPresets.length : 0;

  const [fieldValues, setFieldValues] = useState<Record<string, FieldValue>>(
    {},
  );
  // `pendingConfirm` flips the footer into the inline confirm bar. We
  // never show the bar for create-mode (no installs exist yet) or when
  // there are no affected installs.
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFieldValues(preset ? { ...preset.presetFieldValues } : {});
    setPendingConfirm(false);
    setIsConfirming(false);
  }, [open, preset]);

  async function performSave() {
    setIsConfirming(true);
    try {
      await save();
    } finally {
      setIsConfirming(false);
      setPendingConfirm(false);
    }
  }

  async function save() {
    if (isEdit && preset) {
      if (isEditingDefaultPreset) {
        await updateParent.mutateAsync({
          id: cat.id,
          data: { presetFieldValues: fieldValues },
        });
      } else {
        await update.mutateAsync({
          presetId: preset.id,
          data: { presetFieldValues: fieldValues },
        });
      }
    } else {
      if (!entry) return;
      await create.mutateAsync({
        presetEntryId: entry.id,
        presetFieldValues: fieldValues,
      });
    }
    onOpenChange(false);
  }

  // True when the user has actually changed at least one field value.
  // JSON-stringify deep-equal is fine here — preset values are
  // primitive (string/number/boolean/string[]) and the shape is
  // small. The baseline is whatever the preset/parent currently holds;
  // in create-mode the baseline is empty.
  const baselineValues = useMemo(
    () => (preset?.presetFieldValues ?? {}) as Record<string, FieldValue>,
    [preset],
  );
  const isDirty = useMemo(
    () => JSON.stringify(baselineValues) !== JSON.stringify(fieldValues),
    [baselineValues, fieldValues],
  );

  async function handleClickSave() {
    // Idempotent no-op save: nothing actually changed → skip both
    // the bar AND the API call. The form's API call would otherwise
    // hit the cascade gate which (currently) over-restarts pods on
    // any successful PUT, so an unedited Save would silently restart
    // pods. Just close the dialog.
    if (isEdit && !isDirty) {
      onOpenChange(false);
      return;
    }
    if (isEdit && affectedServerCount > 0 && !pendingConfirm) {
      setPendingConfirm(true);
      return;
    }
    await performSave();
  }

  const isPending =
    create.isPending || update.isPending || updateParent.isPending;

  const title = isEditingDefaultPreset
    ? `Edit default ${singular}`
    : isEdit
      ? `Edit ${singular} — ${preset?.name}`
      : entry
        ? `Configure ${entry.name}`
        : `New ${singular}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]">
        {/*
         * Wrap the editor in a real <form autoComplete="off"> so Chrome's
         * password manager scopes its autofill scan to this form. Without
         * a form ancestor for the secret-typed Input (which renders as
         * <input type="password">), Chrome treats it as an "unaffiliated"
         * password field, hunts the entire page for a username field, and
         * falls back to the catalog SearchInput behind this dialog —
         * filling it with the user's saved Archestra credential
         * (admin@example.com), which then fires its onChange and
         * router.replace, which dismisses BOTH dialogs.
         *
         * onSubmit prevents the native form submission so Enter still
         * triggers our save() instead of a browser navigation.
         */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleClickSave();
          }}
          autoComplete="off"
          className="contents"
        >
          <DialogHeader className="border-b px-6 py-4">
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>

          {/*
           * Lock the field surface while the confirm bar is up (or while
           * the save is in flight) so the user can't mutate values
           * mid-confirm and create a mismatch with the snapshot the API
           * call will receive.
           */}
          <fieldset
            disabled={pendingConfirm || isConfirming}
            className="contents"
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
              {presetFields.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  To vary settings per {singular}, create a {singular}-scoped
                  env variable or header in the Configuration tab first.
                </p>
              ) : (
                <PresetFieldSections
                  fields={presetFields}
                  values={fieldValues}
                  hasStoredSecrets={isEdit && preset?.presetSecretId != null}
                  onChange={(key, v) =>
                    setFieldValues((prev) => {
                      if (v === undefined) {
                        const { [key]: _drop, ...rest } = prev;
                        return rest;
                      }
                      return { ...prev, [key]: v };
                    })
                  }
                />
              )}
            </div>
          </fieldset>

          {pendingConfirm ? (
            <ReinstallConfirmBar
              mode="auto"
              affectedServerCount={affectedServerCount}
              presetCount={otherPresetCount}
              presetEntityName={presetEntityName}
              isSubmitting={isConfirming}
              onCancel={() => setPendingConfirm(false)}
              onConfirm={performSave}
            />
          ) : (
            <DialogFooter className="border-t px-6 py-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isPending || (isEdit && !isDirty)}
              >
                {isPending ? "Saving…" : isEdit ? "Save changes" : "Save"}
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface PresetFieldSectionsProps {
  fields: CatalogFieldEntry[];
  values: Record<string, FieldValue>;
  onChange: (key: string, v: FieldValue | undefined) => void;
  /** When true, secret-typed fields render a `••••••••` placeholder to signal there's a stored value the user can preserve by leaving the input empty. */
  hasStoredSecrets: boolean;
}

function PresetFieldSections({
  fields,
  values,
  onChange,
  hasStoredSecrets,
}: PresetFieldSectionsProps) {
  const envFields = fields.filter((f) => f.origin === "envVar");
  const userConfigFields = fields.filter((f) => f.origin === "userConfig");
  const userConfigHeader =
    userConfigFields.length > 0 && userConfigFields.every((f) => f.headerName)
      ? "Additional Headers"
      : "Connection Settings";

  return (
    <div className="space-y-4">
      {envFields.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-sm font-medium">Environment Variables</h3>
          {envFields.map((f) => (
            <PresetFieldInput
              key={`envVar:${f.key}`}
              field={f}
              idPrefix="preset-field"
              value={asString(values[f.key])}
              onChange={(v) => onChange(f.key, v === "" ? undefined : v)}
              hasStoredSecret={hasStoredSecrets}
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
              idPrefix="preset-field"
              value={asString(values[f.key])}
              onChange={(v) => onChange(f.key, v === "" ? undefined : v)}
              hasStoredSecret={hasStoredSecrets}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function asString(v: FieldValue | undefined): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  return String(v);
}
