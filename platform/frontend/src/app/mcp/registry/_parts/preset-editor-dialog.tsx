"use client";

import type { archestraApiTypes } from "@shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  useCreateCatalogPreset,
  useUpdateCatalogPreset,
  useUpdateInternalMcpCatalogItem,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { PresetFieldInput } from "./preset-field-input";
import {
  type CatalogFieldEntry,
  type CatalogItem,
  listCatalogFields,
} from "./preset-helpers";

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

type FieldValue = string | number | boolean | string[];
type Preset = archestraApiTypes.GetCatalogChildrenResponses["200"][number];

interface PresetEditorDialogProps {
  cat: CatalogItem;
  /** When null, dialog is in "create" mode. When set, edits that preset (or parent's default values when preset.id === cat.id). */
  preset: Preset | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function PresetEditorDialog({
  cat,
  preset,
  open,
  onOpenChange,
}: PresetEditorDialogProps) {
  const isEdit = preset !== null;
  const isEditingDefaultPreset = preset !== null && preset.id === cat.id;

  const presetFields = listCatalogFields(cat).filter(
    (f) => f.scope === "preset",
  );

  const create = useCreateCatalogPreset(cat.id);
  const update = useUpdateCatalogPreset(cat.id);
  const updateParent = useUpdateInternalMcpCatalogItem();

  const [name, setName] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, FieldValue>>(
    {},
  );
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (preset) {
      setName(preset.name);
      setFieldValues({ ...preset.presetFieldValues });
    } else {
      setName("");
      setFieldValues({});
    }
    setNameError(null);
  }, [open, preset]);

  async function save() {
    setNameError(null);
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
      const trimmed = name.trim();
      if (!DNS_LABEL.test(trimmed)) {
        setNameError(
          "Name must be a DNS-1123 label: lowercase alphanumeric and hyphens, starting and ending with alphanumeric.",
        );
        return;
      }
      await create.mutateAsync({
        childName: trimmed,
        presetFieldValues: fieldValues,
      });
    }
    onOpenChange(false);
  }

  const isPending =
    create.isPending || update.isPending || updateParent.isPending;

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
            save();
          }}
          autoComplete="off"
          className="contents"
        >
          <DialogHeader className="border-b px-6 py-4">
            <DialogTitle>
              {isEditingDefaultPreset
                ? "Edit default preset"
                : isEdit
                  ? `Edit preset — ${preset?.name}`
                  : "New preset"}
            </DialogTitle>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
            {!isEdit && (
              <div className="space-y-1.5">
                <Label htmlFor="preset-name">Name</Label>
                <Input
                  id="preset-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="staging"
                  className="font-mono"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  DNS-1123 label, max 63 chars. Immutable after creation.
                </p>
                {nameError && (
                  <p className="text-xs text-destructive" role="alert">
                    {nameError}
                  </p>
                )}
              </div>
            )}

            {presetFields.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This catalog has no preset-scoped fields. Mark fields with{" "}
                <span className="font-mono">promptOnPreset</span> in the
                Configuration tab first.
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

          <DialogFooter className="border-t px-6 py-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending
                ? "Saving…"
                : isEdit
                  ? "Save changes"
                  : "Create preset"}
            </Button>
          </DialogFooter>
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
