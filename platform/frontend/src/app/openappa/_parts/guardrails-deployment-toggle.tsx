"use client";

import { ShieldCheck } from "lucide-react";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useGuardrailsDeployment,
  useUpdateGuardrailsDeployment,
} from "@/lib/guardrails-deployment.query";

export function GuardrailsDeploymentToggle() {
  const query = useGuardrailsDeployment();
  const update = useUpdateGuardrailsDeployment();
  const { data: canManage } = useHasPermissions({ organization: ["update"] });
  if (query.isPending) return <Skeleton className="h-28 w-full" />;
  if (query.isError || !query.data)
    return (
      <QueryLoadError
        title="Could not load guardrails status"
        onRetry={() => query.refetch()}
      />
    );
  const { enabled, active, featureEnabled } = query.data;
  return (
    <section
      aria-label="Deployment guardrails"
      className="flex flex-wrap items-start justify-between gap-4 rounded-lg border bg-card p-4"
    >
      <div className="flex min-w-0 flex-1 gap-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="guardrails-v2-enabled" className="font-semibold">
              Enable Guardrails v2
            </Label>
            <Badge variant="outline">All organizations</Badge>
          </div>
          <p
            id="guardrails-v2-scope"
            className="max-w-2xl text-sm text-muted-foreground"
          >
            Apply APPA policies alongside existing guardrails for every agent in
            this deployment. Existing guardrails stay active when this is off.
          </p>
          <output className="block text-xs text-muted-foreground">
            {!featureEnabled
              ? "The server feature flag is off. APPA enforcement is inactive."
              : active
                ? "Both guardrails engines are active."
                : "Existing guardrails are active. APPA enforcement is off."}
          </output>
        </div>
      </div>
      <Switch
        id="guardrails-v2-enabled"
        aria-describedby="guardrails-v2-scope"
        checked={enabled}
        disabled={!canManage || !featureEnabled || update.isPending}
        onCheckedChange={(value) => update.mutate(value)}
      />
    </section>
  );
}
