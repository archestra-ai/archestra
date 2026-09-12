"use client";

import type { SupportedProvider } from "@archestra/shared";
import { CircleDashed } from "lucide-react";
import { RowClickShield } from "@/components/agent-pages/row-click-shield";
import { ProviderIcon } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function AgentProviderIndicator({
  provider,
  keyName,
  modelName,
}: {
  provider?: SupportedProvider | null;
  keyName?: string | null;
  modelName?: string | null;
}) {
  return (
    <RowClickShield className="inline-flex shrink-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-md"
            aria-label="Provider and model details"
          >
            {provider ? (
              <ProviderIcon provider={provider} size={18} />
            ) : (
              <CircleDashed className="size-[18px] text-muted-foreground" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-80 space-y-3 px-4 py-3 text-left text-sm leading-5"
        >
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Provider key</p>
            <p className="break-words font-medium">
              {keyName || "No key configured"}
            </p>
          </div>
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Model</p>
            <p className="break-words font-medium">
              {modelName || "No model pinned"}
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    </RowClickShield>
  );
}
