"use client";

import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { useSpikeStore } from "../_seed/store";
import type { CatalogItem, Scope } from "../_seed/types";
import { renderTemplate, visibleEnvsForUser } from "./utils";

export function InstallDialog({
  cat,
  triggerLabel = "Install",
  presetEnvironmentId,
}: {
  cat: CatalogItem;
  triggerLabel?: string;
  presetEnvironmentId?: string;
}) {
  const [open, setOpen] = useState(false);
  const { environments, currentUser, installCredential, pods } =
    useSpikeStore();
  const visible = useMemo(
    () =>
      visibleEnvsForUser(
        environments.filter((e) => e.catalogId === cat.id),
        currentUser.teamIds,
      ),
    [environments, cat.id, currentUser.teamIds],
  );
  const [envId, setEnvId] = useState(
    presetEnvironmentId ?? visible[0]?.id ?? "",
  );
  const [scope, setScope] = useState<Scope>("personal");
  const [userValues, setUserValues] = useState<Record<string, string>>({});
  const env = visible.find((e) => e.id === envId);

  const userFields = cat.fields.filter((f) => f.kind === "user");
  const envFields = cat.fields.filter((f) => f.kind === "env");

  function submit() {
    if (!env) return;
    const matchingPod = pods.find((p) => p.environmentId === env.id) ?? pods[0];
    installCredential({
      environmentId: env.id,
      ownerId: currentUser.id,
      ownerEmail: currentUser.email,
      scope,
      podId: matchingPod?.id ?? "pending",
      secretStorage: "Database",
    });
    setOpen(false);
    setUserValues({});
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Install {cat.name}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Environment</Label>
              <Select value={envId} onValueChange={setEnvId}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {visible.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.label}
                      {e.visibility.kind === "team" && (
                        <span className="ml-2 text-muted-foreground text-xs">
                          ({e.visibility.teamName})
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Filtered to environments your teams can access.
              </p>
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
                      key={f.key}
                      className="grid grid-cols-[140px_1fr] items-center gap-3"
                    >
                      <Label className="text-xs font-mono">
                        {f.key}
                        {f.required && (
                          <span className="ml-1 text-destructive">*</span>
                        )}
                      </Label>
                      <Input
                        type={
                          f.type === "secret"
                            ? "password"
                            : f.type === "number"
                              ? "number"
                              : "text"
                        }
                        placeholder={f.description}
                        value={userValues[f.key] ?? ""}
                        onChange={(e) =>
                          setUserValues((v) => ({
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

          {env && envFields.length > 0 && (
            <>
              <Separator />
              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  From environment (preview)
                </div>
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs font-mono">
                    {envFields.map((f) => (
                      <div key={f.key} className="flex gap-2">
                        <span className="text-muted-foreground">{f.key}</span>
                        <span className="truncate">
                          {String(env.fieldValues[f.key] ?? "—")}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}

          {env && cat.mappings.some((m) => m.source.kind === "template") && (
            <>
              <Separator />
              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Resolved at install
                </div>
                <div className="space-y-1.5">
                  {cat.mappings
                    .filter((m) => m.source.kind === "template")
                    .map((m) => (
                      <div
                        key={"name" in m.target ? m.target.name : m.target.path}
                        className="rounded-md border bg-muted/30 p-2.5 font-mono text-[11px] break-all"
                      >
                        <div className="mb-1 flex items-center gap-2">
                          <Badge variant="outline" className="text-[9px]">
                            {m.target.kind}
                          </Badge>
                          <span className="text-muted-foreground">
                            {"name" in m.target ? m.target.name : m.target.path}
                          </span>
                        </div>
                        <div>
                          {m.source.kind === "template" &&
                            renderTemplate(
                              m.source.template,
                              env.fieldValues,
                              userValues,
                            )}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </>
          )}
        </div>
        <DialogFooter className="border-t px-6 py-3">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Install</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
