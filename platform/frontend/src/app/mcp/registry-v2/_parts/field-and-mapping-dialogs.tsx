"use client";

import { useMemo, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { useSpikeStore } from "../_seed/store";
import type {
  CatalogItem,
  FieldType,
  Mapping,
  MappingTarget,
  UserFieldSource,
} from "../_seed/types";

// ───────────────────────── Add Env Field ─────────────────────────

export function AddEnvFieldDialog({
  cat,
  open,
  onOpenChange,
}: {
  cat: CatalogItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { addField } = useSpikeStore();
  const [key, setKey] = useState("");
  const [type, setType] = useState<FieldType>("string");
  const [required, setRequired] = useState(true);
  const [description, setDescription] = useState("");
  const [isStatic, setIsStatic] = useState(false);
  const [staticValue, setStaticValue] = useState("");

  function reset() {
    setKey("");
    setType("string");
    setRequired(true);
    setDescription("");
    setIsStatic(false);
    setStaticValue("");
  }

  function submit() {
    if (!key.trim()) return;
    addField(cat.id, {
      key: key.trim(),
      kind: "env",
      type,
      required,
      description: description.trim() || undefined,
      staticValue: isStatic ? staticValue : undefined,
    });
    reset();
    onOpenChange(false);
  }

  const conflict = cat.fields.some((f) => f.key === key.trim());

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Add environment field</DialogTitle>
          <DialogDescription>
            Admin-set per environment. Values are supplied when creating each
            environment.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="space-y-2">
            <Label htmlFor="env-key">Key</Label>
            <Input
              id="env-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="host"
              className="font-mono text-xs"
            />
            {conflict && (
              <p className="text-xs text-destructive">
                A field named &quot;{key.trim()}&quot; already exists.
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="env-type">Type</Label>
              <Select
                value={type}
                onValueChange={(v) => setType(v as FieldType)}
              >
                <SelectTrigger id="env-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="string">string</SelectItem>
                  <SelectItem value="number">number</SelectItem>
                  <SelectItem value="bool">bool</SelectItem>
                  <SelectItem value="secret">secret</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="block">&nbsp;</Label>
              <Label className="flex cursor-pointer items-center gap-2 rounded-md border border-border p-2.5 hover:bg-muted/30">
                <Checkbox
                  checked={required}
                  onCheckedChange={(v) => setRequired(v === true)}
                />
                <span className="text-sm">Required</span>
              </Label>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="env-desc">Description</Label>
            <Textarea
              id="env-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Vertica host"
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-3 hover:bg-muted/30">
              <Checkbox
                checked={isStatic}
                onCheckedChange={(v) => setIsStatic(v === true)}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <div className="text-sm font-medium">Static value</div>
                <div className="text-xs text-muted-foreground">
                  Fixed at the catalog level. Same for every environment, not
                  prompted in the env editor.
                </div>
              </div>
            </Label>
            {isStatic && (
              <Input
                value={staticValue}
                onChange={(e) => setStaticValue(e.target.value)}
                placeholder="e.g. info"
                className="font-mono text-xs"
              />
            )}
          </div>
        </div>
        <DialogFooter className="border-t px-6 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              !key.trim() || conflict || (isStatic && !staticValue.trim())
            }
          >
            Add field
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Add User Field ─────────────────────────

export function AddUserFieldDialog({
  cat,
  open,
  onOpenChange,
}: {
  cat: CatalogItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { addField } = useSpikeStore();
  const [key, setKey] = useState("");
  const [type, setType] = useState<FieldType>("string");
  const [required, setRequired] = useState(true);
  const [source, setSource] = useState<UserFieldSource>("prompt-install");
  const [description, setDescription] = useState("");

  function reset() {
    setKey("");
    setType("string");
    setRequired(true);
    setSource("prompt-install");
    setDescription("");
  }

  function submit() {
    if (!key.trim()) return;
    addField(cat.id, {
      key: key.trim(),
      kind: "user",
      type,
      required,
      source,
      description: description.trim() || undefined,
    });
    reset();
    onOpenChange(false);
  }

  const conflict = cat.fields.some((f) => f.key === key.trim());

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Add user field</DialogTitle>
          <DialogDescription>
            Supplied by the caller — either prompted at install or sent per-call
            as a header.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="space-y-2">
            <Label htmlFor="user-key">Key</Label>
            <Input
              id="user-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="username"
              className="font-mono text-xs"
            />
            {conflict && (
              <p className="text-xs text-destructive">
                A field named &quot;{key.trim()}&quot; already exists.
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="user-type">Type</Label>
              <Select
                value={type}
                onValueChange={(v) => setType(v as FieldType)}
              >
                <SelectTrigger id="user-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="string">string</SelectItem>
                  <SelectItem value="number">number</SelectItem>
                  <SelectItem value="bool">bool</SelectItem>
                  <SelectItem value="secret">secret</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="block">&nbsp;</Label>
              <Label className="flex cursor-pointer items-center gap-2 rounded-md border border-border p-2.5 hover:bg-muted/30">
                <Checkbox
                  checked={required}
                  onCheckedChange={(v) => setRequired(v === true)}
                />
                <span className="text-sm">Required</span>
              </Label>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Source</Label>
            <RadioGroup
              value={source}
              onValueChange={(v) => setSource(v as UserFieldSource)}
              className="grid gap-2"
            >
              <Label
                htmlFor="src-prompt"
                className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/30 [&:has([data-state=checked])]:border-primary"
              >
                <RadioGroupItem
                  value="prompt-install"
                  id="src-prompt"
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">Prompt at install</div>
                  <div className="text-xs text-muted-foreground">
                    User enters the value once during install. Stored encrypted.
                  </div>
                </div>
              </Label>
              <Label
                htmlFor="src-header"
                className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/30 [&:has([data-state=checked])]:border-primary"
              >
                <RadioGroupItem
                  value="header-per-call"
                  id="src-header"
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">Header per call</div>
                  <div className="text-xs text-muted-foreground">
                    Forwarded by the gateway on every request. Multi-tenant
                    only.
                  </div>
                </div>
              </Label>
            </RadioGroup>
          </div>
          <div className="space-y-2">
            <Label htmlFor="user-desc">Description</Label>
            <Textarea
              id="user-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="DB user"
              rows={2}
            />
          </div>
        </div>
        <DialogFooter className="border-t px-6 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!key.trim() || conflict}>
            Add field
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Add Mapping ─────────────────────────

type SourceKind = "field" | "template";
type TargetKind = "env-var" | "header" | "secret-file";

export function AddMappingDialog({
  cat,
  open,
  onOpenChange,
}: {
  cat: CatalogItem;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { addMapping } = useSpikeStore();
  const [sourceKind, setSourceKind] = useState<SourceKind>("field");
  const [fieldKey, setFieldKey] = useState<string>(cat.fields[0]?.key ?? "");
  const [template, setTemplate] = useState("");
  const [targetKind, setTargetKind] = useState<TargetKind>("env-var");
  const [targetName, setTargetName] = useState("");

  function reset() {
    setSourceKind("field");
    setFieldKey(cat.fields[0]?.key ?? "");
    setTemplate("");
    setTargetKind("env-var");
    setTargetName("");
  }

  const sourceValid = useMemo(() => {
    if (sourceKind === "field") return Boolean(fieldKey);
    return template.trim().length > 0;
  }, [sourceKind, fieldKey, template]);

  function buildTarget(): MappingTarget | null {
    const name = targetName.trim();
    if (!name) return null;
    if (targetKind === "secret-file")
      return { kind: "secret-file", path: name };
    return { kind: targetKind, name };
  }

  function submit() {
    const target = buildTarget();
    if (!target || !sourceValid) return;
    const mapping: Mapping =
      sourceKind === "field"
        ? { source: { kind: "field", key: fieldKey }, target }
        : { source: { kind: "template", template: template.trim() }, target };
    addMapping(cat.id, mapping);
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Add mapping</DialogTitle>
          <DialogDescription>
            Project a field or template onto an env var, header, or secret file
            at runtime.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="space-y-2">
            <Label>Source</Label>
            <RadioGroup
              value={sourceKind}
              onValueChange={(v) => setSourceKind(v as SourceKind)}
              className="grid grid-cols-2 gap-2"
            >
              <Label
                htmlFor="src-field"
                className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/30 [&:has([data-state=checked])]:border-primary"
              >
                <RadioGroupItem
                  value="field"
                  id="src-field"
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">Field</div>
                  <div className="text-xs text-muted-foreground">
                    Direct value from one field.
                  </div>
                </div>
              </Label>
              <Label
                htmlFor="src-template"
                className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/30 [&:has([data-state=checked])]:border-primary"
              >
                <RadioGroupItem
                  value="template"
                  id="src-template"
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">Template</div>
                  <div className="text-xs text-muted-foreground">
                    Compose multiple fields into one value.
                  </div>
                </div>
              </Label>
            </RadioGroup>
          </div>

          {sourceKind === "field" ? (
            <div className="space-y-2">
              <Label htmlFor="map-field">Field</Label>
              <Select value={fieldKey} onValueChange={setFieldKey}>
                <SelectTrigger id="map-field">
                  <SelectValue placeholder="Pick a field" />
                </SelectTrigger>
                <SelectContent>
                  {cat.fields.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      <span className="font-mono text-xs">
                        {f.kind}.{f.key}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="map-template">Template</Label>
              <Textarea
                id="map-template"
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                placeholder="postgresql://{user.username}:{user.password}@{env.host}:{env.port}/{env.database}"
                rows={3}
                className="font-mono text-[11px]"
              />
              <p className="text-xs text-muted-foreground">
                Reference fields with{" "}
                <code className="font-mono">{"{env.<key>}"}</code> or{" "}
                <code className="font-mono">{"{user.<key>}"}</code>.
              </p>
            </div>
          )}

          <div className="grid grid-cols-[140px_1fr] gap-3">
            <div className="space-y-2">
              <Label htmlFor="map-target-kind">Target</Label>
              <Select
                value={targetKind}
                onValueChange={(v) => setTargetKind(v as TargetKind)}
              >
                <SelectTrigger id="map-target-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="env-var">env-var</SelectItem>
                  <SelectItem value="header">header</SelectItem>
                  <SelectItem value="secret-file">secret-file</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="map-target-name">
                {targetKind === "secret-file" ? "Path" : "Name"}
              </Label>
              <Input
                id="map-target-name"
                value={targetName}
                onChange={(e) => setTargetName(e.target.value)}
                placeholder={
                  targetKind === "env-var"
                    ? "DATABASE_URL"
                    : targetKind === "header"
                      ? "Authorization"
                      : "/etc/secrets/db.json"
                }
                className="font-mono text-xs"
              />
            </div>
          </div>
        </div>
        <DialogFooter className="border-t px-6 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!sourceValid || !targetName.trim()}
          >
            Add mapping
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
