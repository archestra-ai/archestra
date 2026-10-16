"use client";

import {
  Bot,
  Check,
  Clock,
  Code,
  Globe,
  HelpCircle,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ExternalConsult } from "@/lib/openappa/external-consults.query";
import { OUTCOME_LABEL } from "./consult-outcome-badge";

export function ConsultServiceCell({
  consult,
}: {
  consult: Pick<
    ExternalConsult,
    "externalName" | "backend" | "role" | "outcome"
  >;
}) {
  const ServiceIcon = ["llm", "jev", "claude_code"].includes(consult.backend)
    ? Bot
    : consult.backend === "url"
      ? Globe
      : ["command", "module"].includes(consult.backend)
        ? Code
        : ShieldCheck;
  const OutcomeIcon =
    consult.outcome === "answered"
      ? Check
      : consult.outcome === "timeout"
        ? Clock
        : consult.outcome === "dismissed"
          ? HelpCircle
          : X;
  const label = OUTCOME_LABEL[consult.outcome];
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="relative flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
        <ServiceIcon
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border border-border bg-background">
              <span
                role="img"
                aria-label={label}
                className={
                  consult.outcome === "answered"
                    ? "text-muted-foreground"
                    : "text-destructive"
                }
              >
                <OutcomeIcon className="size-3" aria-hidden="true" />
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {label}
            {consult.outcome === "answered" && <span> · service replied</span>}
          </TooltipContent>
        </Tooltip>
      </span>
      <div className="min-w-0 space-y-0.5">
        <div
          className="truncate font-mono text-xs leading-4"
          title={consult.externalName}
        >
          {consult.externalName}
        </div>
        <div className="text-[11px] leading-3.5 text-muted-foreground">
          {consult.role.replaceAll("_", " ")}
        </div>
      </div>
    </div>
  );
}
