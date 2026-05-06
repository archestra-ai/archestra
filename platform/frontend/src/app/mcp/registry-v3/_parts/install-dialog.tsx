"use client";

import { useEffect, useMemo, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useCatalogPresets } from "@/lib/mcp/internal-mcp-catalog.query";
import { useInstallMcpServer } from "@/lib/mcp/mcp-server.query";
import { type CatalogItem, listCatalogFields } from "./types";

type Scope = "personal" | "team" | "org";

export function InstallDialog({
  cat,
  open,
  onOpenChange,
  defaultPresetId,
}: {
  cat: CatalogItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Pre-select a specific preset (parent or child catalog id). Defaults to the parent. */
  defaultPresetId?: string;
}) {
  const { data: children = [] } = useCatalogPresets(cat.id);
  const install = useInstallMcpServer();

  const userFields = useMemo(
    () => listCatalogFields(cat).filter((f) => f.scope === "user"),
    [cat],
  );
  const userConfigUserFieldKeys = new Set(
    Object.entries(cat.userConfig ?? {})
      .filter(([, f]) => f.promptOnInstallation)
      .map(([k]) => k),
  );
  const envUserFieldKeys = new Set(
    (cat.localConfig?.environment ?? [])
      .filter((e) => e.promptOnInstallation)
      .map((e) => e.key),
  );

  // Parent IS the default preset. The picker shows [parent, ...children]
  // and `selectedCatalogId` resolves directly to the catalog row to install.
  const presetOptions = useMemo(
    () => [
      { id: cat.id, name: cat.name, isDefault: true },
      ...children.map((c) => ({ id: c.id, name: c.name, isDefault: false })),
    ],
    [cat.id, cat.name, children],
  );

  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>("personal");
  const [selectedCatalogId, setSelectedCatalogId] = useState<string>("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(`${cat.name}`);
    setScope("personal");
    setSelectedCatalogId(defaultPresetId ?? cat.id);
    setValues({});
    setError(null);
  }, [open, cat.id, cat.name, defaultPresetId]);

  async function submit() {
    setError(null);
    const userConfigValues: Record<string, string> = {};
    const environmentValues: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (!v) continue;
      if (userConfigUserFieldKeys.has(k)) userConfigValues[k] = v;
      else if (envUserFieldKeys.has(k)) environmentValues[k] = v;
    }
    try {
      await install.mutateAsync({
        name,
        catalogId: selectedCatalogId || cat.id,
        scope,
        userConfigValues,
        environmentValues,
      });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Install failed");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Install {cat.name}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div>
            <Label className="text-xs">Name</Label>
            <Input
              className="mt-1.5 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Preset</Label>
              <Select
                value={selectedCatalogId}
                onValueChange={setSelectedCatalogId}
              >
                <SelectTrigger className="mt-1.5">
                  <SelectValue placeholder="(default)" />
                </SelectTrigger>
                <SelectContent>
                  {presetOptions.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                      {p.isDefault && (
                        <span className="ml-2 text-muted-foreground text-xs">
                          (default)
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">Personal</SelectItem>
                  <SelectItem value="team">Team</SelectItem>
                  <SelectItem value="org">Organization</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {userFields.length > 0 && (
            <>
              <Separator />
              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  User fields
                </div>
                <div className="space-y-2.5">
                  {userFields.map((f) => (
                    <div
                      key={`${f.origin}:${f.key}`}
                      className="grid grid-cols-[160px_1fr] items-center gap-3"
                    >
                      <Label className="font-mono text-xs">
                        {f.key}
                        {f.required && (
                          <span className="ml-1 text-destructive">*</span>
                        )}
                      </Label>
                      <Input
                        className="text-sm"
                        placeholder={f.description}
                        value={values[f.key] ?? ""}
                        onChange={(e) =>
                          setValues((v) => ({
                            ...v,
                            [f.key]: e.target.value,
                          }))
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="border-t px-6 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={install.isPending}>
            {install.isPending ? "Installing…" : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
