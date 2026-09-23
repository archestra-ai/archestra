"use client";

import { ShieldCheck } from "lucide-react";
import { QueryLoadError } from "@/components/query-load-error";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
  if (query.isPending) return <Skeleton className="h-12 w-full" />;
  if (query.isError || !query.data)
    return (
      <QueryLoadError
        title="Could not load guardrails status"
        onRetry={() => query.refetch()}
      />
    );
  const { enabled, active, featureEnabled } = query.data;
  return (
    <InlineNotice
      variant={enabled ? "success" : "error"}
      aria-label="OpenAPPA enforcement"
      className={
        enabled
          ? "flex-nowrap gap-3 border-emerald-500/30 bg-emerald-500/20 text-emerald-700 dark:text-emerald-400"
          : "flex-nowrap gap-3 border-red-500/30 bg-red-500/10 text-red-500"
      }
    >
      <ShieldCheck />
      <Label
        htmlFor="guardrails-v2-enabled"
        className="shrink-0 text-xs font-medium"
      >
        OpenAPPA is {enabled ? "enabled" : "disabled"}
      </Label>
      <InlineNoticeText id="guardrails-v2-scope" className="flex-1">
        {!featureEnabled
          ? "Server feature flag is off."
          : active
            ? "Policy enforcement is active for this deployment."
            : "Turn on policy enforcement for this deployment."}
      </InlineNoticeText>
      <Switch
        id="guardrails-v2-enabled"
        aria-describedby="guardrails-v2-scope"
        checked={enabled}
        disabled={!canManage || !featureEnabled || update.isPending}
        onCheckedChange={(value) => update.mutate(value)}
      />
    </InlineNotice>
  );
}
