"use client";

import { Settings } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import type { GuardrailsMode } from "@/lib/guardrails-deployment.query";
import { cn } from "@/lib/utils/tailwind";
import { useOpenAppaSetupState } from "./use-openappa-setup-state";

const MODE_BADGE: Record<
  GuardrailsMode,
  { label: string; title: string; tone?: string; dot: string }
> = {
  off: {
    label: "Enforcement off",
    title: "Your policy isn't applied, so agents can call any tool.",
    dot: "bg-muted-foreground",
  },
  observe: {
    label: "Observe only",
    title:
      "Every tool call is checked and recorded, but calls your policy would block still run.",
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200",
    dot: "bg-amber-500",
  },
  enforce: {
    label: "Enforcement on",
    title: "Every tool call is checked against your policy before it runs.",
    tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    dot: "bg-emerald-500",
  },
};

/**
 * The Overview's header: the mode Guardrails run in, and the way to the
 * Guardrails settings, where the mode and GitHub sync are configured.
 */
export function OverviewHeaderActions() {
  const { mode } = useOpenAppaSetupState();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const badge = mode && MODE_BADGE[mode];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {badge && (
        <Badge
          variant="outline"
          className={cn(
            // On phones the title row only fits the title and Settings, so
            // the state stays one tap away in Settings rather than here.
            "hidden h-8 gap-2 rounded-full px-3 text-[13px] sm:inline-flex",
            badge.tone,
          )}
          title={badge.title}
        >
          <span aria-hidden className={cn("size-2 rounded-full", badge.dot)} />
          <span>{badge.label}</span>
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
