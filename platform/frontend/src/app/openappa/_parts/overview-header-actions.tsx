"use client";

import { Settings } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { cn } from "@/lib/utils/tailwind";
import { useOpenAppaSetupState } from "./use-openappa-setup-state";

/**
 * The Overview's header: whether enforcement is on, and the way to the
 * Guardrails settings, where enforcement and GitHub sync are configured.
 */
export function OverviewHeaderActions() {
  const { enabled } = useOpenAppaSetupState();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {enabled !== undefined && (
        <Badge
          variant="outline"
          className={cn(
            // On phones the title row only fits the title and Settings, so
            // the state stays one tap away in Settings rather than here.
            "hidden h-8 gap-2 rounded-full px-3 text-[13px] sm:inline-flex",
            enabled &&
              "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
          )}
          title={
            enabled
              ? "Every tool call is checked against your policy before it runs."
              : "Your policy isn't applied, so agents can call any tool."
          }
        >
          <span
            aria-hidden
            className={cn(
              "size-2 rounded-full",
              enabled ? "bg-emerald-500" : "bg-muted-foreground",
            )}
          />
          <span>{enabled ? "Enforcement on" : "Enforcement off"}</span>
        </Badge>
      )}
      {canManage && (
        <Button size="sm" variant="outline" asChild>
          <Link href="/settings/guardrails">
            <Settings />
            <span>Settings</span>
          </Link>
        </Button>
      )}
    </div>
  );
}
