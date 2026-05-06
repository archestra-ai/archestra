"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSpikeStore } from "../_seed/store";
import type { CatalogItem, Environment } from "../_seed/types";

type FieldValues = Record<string, string>;

export function EnvironmentEditorDialog({
  cat,
  env,
  open,
  onOpenChange,
}: {
  cat: CatalogItem;
  /** When provided, dialog edits this env. When null, creates new. */
  env: Environment | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { teams, upsertEnvironment } = useSpikeStore();
  const envFields = useMemo(
    () =>
      cat.fields.filter((f) => f.kind === "env" && f.staticValue === undefined),
    [cat.fields],
  );
  const defaultTeamId = teams[0]?.id ?? "";

  const [label, setLabel] = useState("");
  const [visibilityKind, setVisibilityKind] = useState<"org" | "team">("team");
  const [teamId, setTeamId] = useState<string>(teams[0]?.id ?? "");
  const [isDefault, setIsDefault] = useState(false);
  const [values, setValues] = useState<FieldValues>({});

  // Reset form state when the dialog opens. Effect runs only on open/env
  // transitions; envFields/defaultTeamId are read but not in deps to avoid
  // re-running on every parent render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (!open) return;
    if (env) {
      setLabel(env.label);
      setVisibilityKind(env.visibility.kind);
      if (env.visibility.kind === "team") setTeamId(env.visibility.teamId);
      setIsDefault(env.isDefault);
      const next: FieldValues = {};
      for (const f of envFields) {
        const v = env.fieldValues[f.key];
        next[f.key] = v === undefined ? "" : String(v);
      }
      setValues(next);
    } else {
      setLabel("");
      setVisibilityKind("team");
      setTeamId(defaultTeamId);
      setIsDefault(false);
      const next: FieldValues = {};
      for (const f of envFields) next[f.key] = "";
      setValues(next);
    }
  }, [open, env]);

  function submit() {
    const trimmed = label.trim();
    if (!trimmed) return;
    const teamName = teams.find((t) => t.id === teamId)?.name ?? "";

    const fieldValues: Environment["fieldValues"] = {};
    for (const f of envFields) {
      const raw = values[f.key]?.trim() ?? "";
      if (!raw && !f.required) continue;
      if (f.type === "number") {
        const n = Number(raw);
        if (!Number.isNaN(n)) fieldValues[f.key] = n;
      } else if (f.type === "bool") {
        fieldValues[f.key] = raw === "true";
      } else {
        fieldValues[f.key] = raw;
      }
    }

    const next: Environment = {
      id: env?.id ?? `env-${Math.random().toString(36).slice(2, 8)}`,
      catalogId: cat.id,
      label: trimmed,
      visibility:
        visibilityKind === "org"
          ? { kind: "org" }
          : { kind: "team", teamId, teamName },
      fieldValues,
      isDefault,
      createdAt: env?.createdAt ?? new Date().toISOString(),
    };
    upsertEnvironment(next);
    onOpenChange(false);
  }

  const isEdit = env !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>
            {isEdit ? "Edit environment" : "New environment"}
          </DialogTitle>
          <DialogDescription>
            A named parameter set against {cat.name}. Visibility controls who
            can install it.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="space-y-2">
            <Label htmlFor="env-label">Name</Label>
            <Input
              id="env-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Studio 1"
            />
          </div>

          <div className="space-y-2">
            <Label>Visibility</Label>
            <RadioGroup
              value={visibilityKind}
              onValueChange={(v) => setVisibilityKind(v as "org" | "team")}
              className="grid grid-cols-2 gap-2"
            >
              <Label
                htmlFor="vis-org"
                className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/30 [&:has([data-state=checked])]:border-primary"
              >
                <RadioGroupItem value="org" id="vis-org" className="mt-0.5" />
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">Org-wide</div>
                  <div className="text-xs text-muted-foreground">
                    Any member can install.
                  </div>
                </div>
              </Label>
              <Label
                htmlFor="vis-team"
                className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/30 [&:has([data-state=checked])]:border-primary"
              >
                <RadioGroupItem value="team" id="vis-team" className="mt-0.5" />
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">Team</div>
                  <div className="text-xs text-muted-foreground">
                    Only members of one team can install.
                  </div>
                </div>
              </Label>
            </RadioGroup>
            {visibilityKind === "team" && (
              <Select value={teamId} onValueChange={setTeamId}>
                <SelectTrigger className="mt-2">
                  <SelectValue placeholder="Pick a team" />
                </SelectTrigger>
                <SelectContent>
                  {teams.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {envFields.length > 0 && (
            <div className="space-y-3">
              <Label className="block">Environment field values</Label>
              <div className="space-y-2.5">
                {envFields.map((f) => (
                  <div
                    key={f.key}
                    className="grid grid-cols-[140px_1fr] items-center gap-3"
                  >
                    <Label className="font-mono text-xs">
                      {f.key}
                      {f.required && (
                        <span className="ml-1 text-destructive">*</span>
                      )}
                    </Label>
                    <Input
                      type={
                        f.type === "number"
                          ? "number"
                          : f.type === "secret"
                            ? "password"
                            : "text"
                      }
                      value={values[f.key] ?? ""}
                      onChange={(e) =>
                        setValues((v) => ({ ...v, [f.key]: e.target.value }))
                      }
                      placeholder={f.description}
                      className="font-mono text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <Label className="flex cursor-pointer items-center gap-2 rounded-md border border-border p-2.5 hover:bg-muted/30">
            <Checkbox
              checked={isDefault}
              onCheckedChange={(v) => setIsDefault(v === true)}
            />
            <span className="text-sm">Mark as default environment</span>
          </Label>
        </div>
        <DialogFooter className="border-t px-6 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!label.trim() || (visibilityKind === "team" && !teamId)}
          >
            {isEdit ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
