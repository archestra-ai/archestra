"use client";

import { Server, Trash2, X } from "lucide-react";
import { useState } from "react";
import { DeploymentStatusDot } from "@/app/mcp/registry/_parts/deployment-status";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useSpikeStore } from "../_seed/store";
import type { CatalogItem } from "../_seed/types";
import { ConfigurationSection } from "./dialog-sections/configuration";
import { CredentialsSection } from "./dialog-sections/credentials";
import { DeploymentsSection } from "./dialog-sections/deployments";
import { EnvironmentsSection } from "./dialog-sections/environments";
import { K8sYamlSection } from "./dialog-sections/k8s-yaml";
import { envHealth, podsForCatalog, podsRunning } from "./utils";

type Page =
  | "configuration"
  | "environments"
  | "credentials"
  | "deployments"
  | "k8s-yaml";

const navItems: { id: Page; label: string }[] = [
  { id: "configuration", label: "Configuration" },
  { id: "environments", label: "Environments" },
  { id: "credentials", label: "Credentials" },
  { id: "deployments", label: "Deployments" },
  { id: "k8s-yaml", label: "K8s YAML" },
];

const titles: Record<Page, string> = {
  configuration: "Configuration",
  environments: "Environments",
  credentials: "Credentials",
  deployments: "Deployments",
  "k8s-yaml": "K8s YAML",
};

export function CatalogDetailDialog({
  cat,
  open,
  onOpenChange,
}: {
  cat: CatalogItem | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [page, setPage] = useState<Page>("configuration");
  const { environments, credentials, pods } = useSpikeStore();

  if (!cat) return null;

  const cpods = podsForCatalog(pods, cat.id);
  const running = podsRunning(cpods);
  const health = envHealth(cpods.map((p) => p.status));
  const envCount = environments.filter((e) => e.catalogId === cat.id).length;
  const credCount = credentials.filter((c) => {
    const env = environments.find((e) => e.id === c.environmentId);
    return env?.catalogId === cat.id;
  }).length;

  const counts: Record<Page, number | undefined> = {
    configuration: undefined,
    environments: envCount,
    credentials: credCount,
    deployments: cpods.length,
    "k8s-yaml": undefined,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-6xl h-[85vh] flex flex-row p-0 gap-0 overflow-hidden"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{cat.name}</DialogTitle>
        <DialogDescription className="sr-only">
          Catalog item settings
        </DialogDescription>

        <nav className="flex w-[220px] shrink-0 flex-col border-r">
          <div className="flex min-h-[72px] items-center border-b px-4 py-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="rounded bg-muted p-1.5">
                <Server className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{cat.name}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {cpods.length > 0 ? (
                    <DeploymentStatusDot state={health} />
                  ) : (
                    <span className="inline-block h-2 w-2 rounded-full bg-muted" />
                  )}
                  {running} of {cpods.length} pods running
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-1 flex-col gap-0.5 px-2 py-3">
            {navItems.map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                className={cn(
                  "h-9 w-full justify-start px-3 font-normal",
                  page === item.id &&
                    "bg-accent font-medium text-accent-foreground",
                )}
                onClick={() => setPage(item.id)}
              >
                {item.label}
                {counts[item.id] !== undefined && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {counts[item.id]}
                  </span>
                )}
              </Button>
            ))}
          </div>

          <div className="flex flex-col gap-1.5 px-2 pb-3">
            <Separator className="mb-1" />
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-[72px] shrink-0 items-center justify-between border-b px-4 py-4">
            <h2 className="text-lg font-semibold">{titles[page]}</h2>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-xs opacity-70 hover:opacity-100"
              onClick={() => onOpenChange(false)}
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {page === "configuration" && <ConfigurationSection cat={cat} />}
            {page === "environments" && (
              <EnvironmentsSection catalogId={cat.id} />
            )}
            {page === "credentials" && <CredentialsSection cat={cat} />}
            {page === "deployments" && (
              <DeploymentsSection catalogId={cat.id} />
            )}
            {page === "k8s-yaml" && <K8sYamlSection cat={cat} />}
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
