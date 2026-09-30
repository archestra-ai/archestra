"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { ExternalLink, Info } from "lucide-react";
import Link from "next/link";
import { OpenAppaAlertIcon } from "@/components/openappa-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useGuardrailsDeployment,
  useUpdateUnsupportedClientAction,
} from "@/lib/guardrails-deployment.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * Sidebar warning: the deployment has Guardrails but enforcement is off, so
 * tool calls run unchecked. It links to the Guardrails page, where an
 * administrator turns it on.
 *
 * Nothing renders while enforcement is on. A row that only ever reports that
 * things are fine is a row the reader stops reading, which costs the warning
 * the attention it exists for. Shown where the navigation has no Guardrails
 * row of its own to carry the same warning.
 */
export function GuardrailsDisabledWarning() {
  const query = useGuardrailsDeployment();
  if (!query.data || query.isError || query.data.enabled) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        tooltip="Guardrails enforcement is off"
        className="text-destructive hover:text-destructive"
      >
        <Link href="/openappa">
          <OpenAppaAlertIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Guardrails disabled</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function UnsupportedClientActionSelect({
  className,
}: {
  className?: string;
}) {
  const query = useGuardrailsDeployment();
  const update = useUpdateUnsupportedClientAction();
  const { data: canManage } = useHasPermissions({ organization: ["update"] });
  if (!query.data || query.isError) return null;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 pt-3 border-t border-border/60 text-left",
        className,
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-sm text-muted-foreground select-none">
          Unsupported clients
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label="About unsupported clients"
            >
              <Info className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            className="max-w-xs space-y-1.5 p-3 text-xs"
          >
            <p>
              Clients without session headers or recognized adapters cannot
              maintain a guardrails session.
            </p>
            <p>
              <a
                href={getDocsUrl(
                  DocsPage.PlatformAiToolGuardrails,
                  "client-support-matrix",
                )}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2 hover:text-primary/80"
              >
                <span>Learn more</span>
                <ExternalLink className="size-3" />
              </a>
            </p>
          </TooltipContent>
        </Tooltip>
      </div>
      <Select
        value={query.data.unsupportedClientAction}
        disabled={!canManage || !query.data.featureEnabled || update.isPending}
        onValueChange={(value) => {
          if (value === "bypass" || value === "block") update.mutate(value);
        }}
      >
        <SelectTrigger
          id="openappa-unsupported-clients"
          aria-label="Unsupported clients"
          className="h-8 w-28 text-sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="bypass" className="text-sm">
            Bypass
          </SelectItem>
          <SelectItem value="block" className="text-sm">
            Block
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
