"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { CatalogItem, FieldDef } from "../../_seed/types";
import {
  AddEnvFieldDialog,
  AddMappingDialog,
  AddUserFieldDialog,
} from "../field-and-mapping-dialogs";

function FieldsTable({ fields }: { fields: FieldDef[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[160px]">Key</TableHead>
          <TableHead className="w-[100px]">Type</TableHead>
          <TableHead className="w-[100px]">Required</TableHead>
          <TableHead className="w-[160px]">Source</TableHead>
          <TableHead>Description</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {fields.map((f) => (
          <TableRow key={f.key}>
            <TableCell className="font-mono text-xs">{f.key}</TableCell>
            <TableCell className="text-xs">{f.type}</TableCell>
            <TableCell className="text-xs">
              {f.required ? (
                "required"
              ) : (
                <span className="text-muted-foreground">optional</span>
              )}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {f.kind === "user" ? (
                f.source
              ) : f.staticValue !== undefined ? (
                <span className="font-mono">
                  static{" "}
                  <span className="text-foreground">
                    &quot;{f.staticValue}&quot;
                  </span>
                </span>
              ) : (
                "per-environment"
              )}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {f.description ?? "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function ConfigurationSection({ cat }: { cat: CatalogItem }) {
  const envFields = cat.fields.filter((f) => f.kind === "env");
  const userFields = cat.fields.filter((f) => f.kind === "user");
  const [envFieldOpen, setEnvFieldOpen] = useState(false);
  const [userFieldOpen, setUserFieldOpen] = useState(false);
  const [mappingOpen, setMappingOpen] = useState(false);

  return (
    <div className="space-y-8 px-4 py-4">
      <section className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" defaultValue={cat.name} />
        </div>
        <div className="space-y-2">
          <Label>Tenancy</Label>
          <RadioGroup
            defaultValue={cat.tenancy}
            className="grid grid-cols-2 gap-3"
          >
            <Label
              htmlFor="t-single"
              className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/30 [&:has([data-state=checked])]:border-primary"
            >
              <RadioGroupItem value="single" id="t-single" className="mt-0.5" />
              <div className="space-y-0.5">
                <div className="text-sm font-medium">Single-tenant</div>
                <div className="text-xs text-muted-foreground">
                  One pod per (environment, scope-target).
                </div>
              </div>
            </Label>
            <Label
              htmlFor="t-multi"
              className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/30 [&:has([data-state=checked])]:border-primary"
            >
              <RadioGroupItem value="multi" id="t-multi" className="mt-0.5" />
              <div className="space-y-0.5">
                <div className="text-sm font-medium">Multi-tenant</div>
                <div className="text-xs text-muted-foreground">
                  Shared pod, per-call headers.
                </div>
              </div>
            </Label>
          </RadioGroup>
        </div>
      </section>

      <Separator />

      <section className="space-y-4">
        <SectionHeader
          title="Deployment"
          description="How the server runs in Kubernetes."
        />
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="cmd">Command</Label>
            <Input
              id="cmd"
              defaultValue={cat.command ?? ""}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="img">Image</Label>
            <Input
              id="img"
              defaultValue={cat.image ?? ""}
              className="font-mono text-xs"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="args">Arguments (one per line)</Label>
          <Textarea
            id="args"
            defaultValue={cat.args.join("\n")}
            className="font-mono text-xs"
            rows={3}
          />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="transport">Transport</Label>
            <Select defaultValue={cat.transport}>
              <SelectTrigger id="transport">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
                <SelectItem value="stdio">stdio</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {cat.transport === "streamable-http" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="port">HTTP Port</Label>
                <Input
                  id="port"
                  defaultValue={cat.httpPort}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="path">HTTP Path</Label>
                <Input
                  id="path"
                  defaultValue={cat.httpPath}
                  className="font-mono text-xs"
                />
              </div>
            </>
          )}
        </div>
      </section>

      <Separator />

      <section className="space-y-4">
        <SectionHeader
          title="Fields"
          description="Environment fields are admin-set per environment. User fields are supplied by the caller."
          action={
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEnvFieldOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                Env field
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setUserFieldOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                User field
              </Button>
            </div>
          }
        />
        {envFields.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Environment fields
            </div>
            <FieldsTable fields={envFields} />
          </div>
        )}
        {userFields.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              User fields
            </div>
            <FieldsTable fields={userFields} />
          </div>
        )}
      </section>

      <Separator />

      <section className="space-y-4">
        <SectionHeader
          title="Mappings"
          description="How field values are projected onto env vars or headers at runtime."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMappingOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              Mapping
            </Button>
          }
        />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead className="w-[120px]">Target</TableHead>
              <TableHead>Name</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cat.mappings.map((m) => (
              <TableRow
                key={"name" in m.target ? m.target.name : m.target.path}
              >
                <TableCell>
                  {m.source.kind === "field" ? (
                    <span className="font-mono text-xs">
                      <span className="text-muted-foreground">field </span>
                      {m.source.key}
                    </span>
                  ) : (
                    <div className="space-y-1">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        template
                      </div>
                      <div className="break-all font-mono text-[11px] leading-relaxed">
                        {m.source.template}
                      </div>
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-[10px]">
                    {m.target.kind}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {"name" in m.target ? m.target.name : m.target.path}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <Separator />

      <section className="space-y-3">
        <SectionHeader
          title="Authentication"
          description="How the gateway proves caller identity to a multi-tenant server."
        />
        <RadioGroup
          defaultValue={cat.authType}
          className="grid grid-cols-2 gap-3"
        >
          {(
            [
              {
                v: "none",
                label: "None",
                desc: "Credentials passed via env vars only.",
              },
              {
                v: "token",
                label: "Token header",
                desc: "Prompt the user for a token at install.",
              },
              {
                v: "oauth",
                label: "OAuth 2.1",
                desc: "Auto-discovered from server URL.",
              },
              {
                v: "jwt",
                label: "Signed JWT",
                desc: "Sign per-call with configured IdP key.",
              },
            ] as const
          ).map((opt) => (
            <Label
              key={opt.v}
              htmlFor={`auth-${opt.v}`}
              className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/30 [&:has([data-state=checked])]:border-primary"
            >
              <RadioGroupItem
                value={opt.v}
                id={`auth-${opt.v}`}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <div className="text-sm font-medium">{opt.label}</div>
                <div className="text-xs text-muted-foreground">{opt.desc}</div>
              </div>
            </Label>
          ))}
        </RadioGroup>
      </section>

      <Separator />

      <section className="space-y-3">
        <SectionHeader
          title="Labels"
          description="Tag this catalog item for search and grouping."
        />
        <div className="flex flex-wrap gap-1.5">
          {cat.labels.length === 0 ? (
            <span className="text-xs text-muted-foreground">No labels.</span>
          ) : (
            cat.labels.map((l) => (
              <Badge key={l} variant="secondary">
                {l}
              </Badge>
            ))
          )}
        </div>
      </section>

      <AddEnvFieldDialog
        cat={cat}
        open={envFieldOpen}
        onOpenChange={setEnvFieldOpen}
      />
      <AddUserFieldDialog
        cat={cat}
        open={userFieldOpen}
        onOpenChange={setUserFieldOpen}
      />
      <AddMappingDialog
        cat={cat}
        open={mappingOpen}
        onOpenChange={setMappingOpen}
      />
    </div>
  );
}
