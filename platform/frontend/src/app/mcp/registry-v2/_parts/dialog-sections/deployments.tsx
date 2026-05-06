"use client";

import {
  ChevronRight,
  FileText,
  RefreshCw,
  ScrollText,
  Search,
  Terminal as TerminalIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { DeploymentStatusDot } from "@/app/mcp/registry/_parts/deployment-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useSpikeStore } from "../../_seed/store";
import type { Pod } from "../../_seed/types";
import { fmtDate, podStateMapping } from "../utils";

function PodActionDialog({
  pod,
  action,
  open,
  onOpenChange,
}: {
  pod: Pod | null;
  action: "logs" | "shell" | "inspector" | "yaml" | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  if (!pod || !action) return null;
  const titleMap = {
    logs: `Logs · ${pod.name}`,
    shell: `Shell · ${pod.name}`,
    inspector: `Inspector · ${pod.name}`,
    yaml: `K8s YAML · ${pod.name}`,
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>{titleMap[action]}</DialogTitle>
        </DialogHeader>
        <div className="rounded-md border bg-black p-4 font-mono text-[11px] text-green-400">
          {action === "logs" && (
            <pre className="whitespace-pre-wrap">{`[2026-05-03 22:35:00] starting mcp server
[2026-05-03 22:35:00] transport=streamable-http port=8080 path=/mcp
[2026-05-03 22:35:01] connected to upstream
[2026-05-03 22:35:01] ready
[2026-05-03 22:36:14] tools/list called by alice@example.com (env=Studio 1)
[2026-05-03 22:36:14] returning 5 tools`}</pre>
          )}
          {action === "shell" && (
            <pre className="whitespace-pre-wrap">{`$ kubectl exec -it ${pod.name} -- sh
/ # echo "spike: shell stub"
spike: shell stub
/ # _`}</pre>
          )}
          {action === "inspector" && (
            <div className="text-muted-foreground">
              Inspector UI would mount here.
            </div>
          )}
          {action === "yaml" && (
            <pre className="whitespace-pre-wrap text-yellow-300">{`apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${pod.name}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${pod.name}
  template:
    spec:
      containers:
        - name: mcp
          image: ${pod.image}`}</pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PodRow({ pod }: { pod: Pod }) {
  const { environments, restartPod } = useSpikeStore();
  const env = environments.find((e) => e.id === pod.environmentId);
  const podState = podStateMapping(pod.status);
  const [expanded, setExpanded] = useState(false);
  const [dialogAction, setDialogAction] = useState<
    "logs" | "shell" | "inspector" | "yaml" | null
  >(null);

  return (
    <>
      <div
        className={cn("border-b last:border-b-0", expanded && "bg-muted/20")}
      >
        <button
          type="button"
          className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/30"
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronRight
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-xs">{pod.name}</span>
              {env && (
                <Badge variant="secondary" className="text-[10px] shrink-0">
                  {env.label}
                </Badge>
              )}
              <Badge variant="outline" className="text-[10px] shrink-0">
                {pod.tenancy === "multi" ? "multi-tenant" : "single-tenant"}
              </Badge>
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              owner: {pod.ownerLabel} · {pod.callerCount}{" "}
              {pod.callerCount === 1 ? "caller" : "callers"}
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <DeploymentStatusDot state={podState.state} />
            <span className="text-muted-foreground">{podState.label}</span>
          </div>
        </button>
        {expanded && (
          <div className="space-y-3 border-t bg-card px-4 py-3">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs md:grid-cols-4">
              <div>
                <div className="text-muted-foreground">Tenancy</div>
                <div className="mt-0.5">
                  {pod.tenancy === "multi" ? "multi-tenant" : "single-tenant"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Started</div>
                <div className="mt-0.5">{fmtDate(pod.startedAt)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Restarts</div>
                <div className="mt-0.5">{pod.restarts}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Callers</div>
                <div className="mt-0.5">{pod.callerCount}</div>
              </div>
              <div className="col-span-2 md:col-span-4">
                <div className="text-muted-foreground">Image</div>
                <div className="mt-0.5 font-mono">{pod.image}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDialogAction("logs")}
              >
                <ScrollText className="h-3.5 w-3.5" />
                Logs
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDialogAction("shell")}
              >
                <TerminalIcon className="h-3.5 w-3.5" />
                Shell
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDialogAction("inspector")}
              >
                <Search className="h-3.5 w-3.5" />
                Inspector
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => restartPod(pod.id)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Restart
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDialogAction("yaml")}
              >
                <FileText className="h-3.5 w-3.5" />
                K8s YAML
              </Button>
            </div>
          </div>
        )}
      </div>
      <PodActionDialog
        pod={pod}
        action={dialogAction}
        open={dialogAction !== null}
        onOpenChange={(v) => !v && setDialogAction(null)}
      />
    </>
  );
}

export function DeploymentsSection({ catalogId }: { catalogId: string }) {
  const { environments, pods } = useSpikeStore();
  const cpods = pods.filter((p) => p.catalogId === catalogId);
  const envs = environments.filter((e) => e.catalogId === catalogId);
  const [envFilter, setEnvFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const filtered = useMemo(
    () =>
      cpods.filter(
        (p) =>
          (envFilter === "all" || p.environmentId === envFilter) &&
          (statusFilter === "all" || p.status === statusFilter),
      ),
    [cpods, envFilter, statusFilter],
  );

  return (
    <div className="space-y-4 px-4 py-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          Per-pod runtime view. Logs, shell, inspector, restart all live here
          per-pod.
        </p>
        <div className="flex items-center gap-2">
          <Select value={envFilter} onValueChange={setEnvFilter}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Environment" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All environments</SelectItem>
              {envs.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="up">up</SelectItem>
              <SelectItem value="down">down</SelectItem>
              <SelectItem value="restarting">restarting</SelectItem>
              <SelectItem value="degraded">degraded</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground">
              No pods match the current filters.
            </div>
          ) : (
            filtered.map((p) => <PodRow key={p.id} pod={p} />)
          )}
        </CardContent>
      </Card>
    </div>
  );
}
