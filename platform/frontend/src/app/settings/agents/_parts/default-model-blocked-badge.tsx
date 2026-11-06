"use client";

import { ChevronDown, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { RuntimeAgent } from "./runtime-agent";
import { UpdateAgentModelsDialog } from "./update-agent-models-dialog";

/**
 * Shown under the default model picker when Agent Runtime agents that follow
 * the default can't run the chosen model. The popover names them, and each
 * can be given a model of its own here, alone or all at once.
 */
export function DefaultModelBlockedBadge({
  agents,
  hiddenCount,
  reason,
  allClaudeCode,
  modelName,
}: {
  /** The blocking agents the viewer can read. */
  agents: RuntimeAgent[];
  /** Blocking agents the viewer can't read: counted, never named. */
  hiddenCount: number;
  /** Why they can't run the model, in one sentence. */
  reason: string;
  allClaudeCode: boolean;
  modelName: string;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [dialogAgents, setDialogAgents] = useState<RuntimeAgent[] | null>(null);
  const count = agents.length + hiddenCount;
  const one = count === 1;
  const shown = agents.slice(0, PREVIEW_LIMIT);
  const more = agents.length - shown.length;

  const openDialog = (forAgents: RuntimeAgent[]) => {
    setPopoverOpen(false);
    setDialogAgents(forAgents);
  };

  if (count === 0 && dialogAgents === null) return null;

  return (
    <div className="flex">
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Badge
            asChild
            variant="outline"
            className="group cursor-pointer gap-1.5 border-amber-500/25 bg-amber-500/[0.06] py-1 pr-1.5 pl-2 text-amber-800 transition-colors hover:bg-amber-500/10 focus-visible:ring-amber-500/30 data-[state=open]:bg-amber-500/10 dark:border-amber-400/20 dark:bg-amber-400/[0.06] dark:text-amber-200 dark:hover:bg-amber-400/10 dark:data-[state=open]:bg-amber-400/10"
          >
            <UnstyledButton>
              <TriangleAlert className="text-amber-600 dark:text-amber-400" />
              {one
                ? "1 agent can't run this"
                : `${count} agents can't run this`}
              <ChevronDown className="opacity-60 transition-transform duration-200 group-data-[state=open]:rotate-180" />
            </UnstyledButton>
          </Badge>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden p-0"
        >
          <div className="space-y-1 px-3.5 pt-3 pb-2.5">
            <p className="text-sm leading-snug font-medium break-words">
              Can't make {modelName} the default
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {one
                ? "This agent has no model of its own. "
                : `These ${count} agents have no model of their own. `}
              {reason}
            </p>
          </div>

          <ul className="border-y bg-muted/40 py-1">
            {shown.map((agent) => (
              <li
                key={agent.id}
                className="flex items-center gap-3 px-3.5 py-1.5 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                <UnstyledButton
                  onClick={() => openDialog([agent])}
                  className="shrink-0 text-xs text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground"
                >
                  Set model
                </UnstyledButton>
              </li>
            ))}
            {more > 0 && (
              <li className="px-3.5 py-1.5 text-xs text-muted-foreground">
                and {more} more
              </li>
            )}
            {hiddenCount > 0 && (
              <li className="px-3.5 py-1.5 text-xs text-muted-foreground">
                {hiddenCount === 1
                  ? "1 agent you can't view"
                  : `${hiddenCount} agents you can't view`}
              </li>
            )}
          </ul>

          <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs">
            <span className="text-muted-foreground">
              Or choose a different default.
            </span>
            {agents.length > 1 && (
              <UnstyledButton
                onClick={() => openDialog(agents)}
                className="shrink-0 font-medium underline decoration-foreground/30 underline-offset-2 transition-colors hover:decoration-foreground"
              >
                Set models for all {agents.length}
              </UnstyledButton>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <UpdateAgentModelsDialog
        open={dialogAgents !== null}
        onOpenChange={(open) => {
          if (!open) setDialogAgents(null);
        }}
        agents={dialogAgents ?? []}
        modelName={modelName}
        allClaudeCode={allClaudeCode}
        onSaved={() => setDialogAgents(null)}
      />
    </div>
  );
}

// === Internal helpers ===

const PREVIEW_LIMIT = 5;
