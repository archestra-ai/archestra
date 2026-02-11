"use client";

import type { LucideIcon } from "lucide-react";
import { ArrowRight, Bot, ExternalLink, Network, Shield } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type DocsPage =
  | "platform-agents"
  | "platform-llm-proxy"
  | "platform-mcp-gateway";

const AGENT_TYPE_CONFIG: Record<
  string,
  { icon: LucideIcon; titlePrefix: string }
> = {
  agent: { icon: Bot, titlePrefix: "Connect to" },
  mcp_gateway: { icon: Shield, titlePrefix: "Connect via" },
  llm_proxy: { icon: Network, titlePrefix: "Connect via" },
  profile: { icon: Shield, titlePrefix: "Connect via" },
};

interface ConnectDialogProps {
  agent: {
    name: string;
    agentType: "profile" | "mcp_gateway" | "llm_proxy" | "agent";
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  docsPage: DocsPage;
  children: ReactNode;
}

export function ConnectDialog({
  agent,
  open,
  onOpenChange,
  docsPage,
  children,
}: ConnectDialogProps) {
  const config = AGENT_TYPE_CONFIG[agent.agentType] ?? AGENT_TYPE_CONFIG.agent;
  const Icon = config.icon;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl h-[90vh] p-0 flex flex-col border-0">
        {/* Header with gradient */}
        <div className="relative bg-gradient-to-br from-primary/10 via-primary/5 to-background px-6 pt-6 pb-5 shrink-0">
          <div className="absolute inset-0 bg-grid-white/[0.02] pointer-events-none" />
          <div className="relative">
            <DialogHeader>
              <div className="flex items-center gap-2 mb-1">
                <div className="p-1.5 rounded-full bg-primary/10">
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <DialogTitle className="text-xl font-semibold">
                  {config.titlePrefix} "{agent.name}"
                </DialogTitle>
              </div>
            </DialogHeader>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t bg-muted/30 shrink-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            <span>
              Need help? Check our{" "}
              <a
                href={`https://archestra.ai/docs/${docsPage}`}
                target="_blank"
                className="text-primary hover:underline font-medium"
                rel="noopener"
              >
                documentation
              </a>
            </span>
          </div>
          <Button
            type="button"
            onClick={() => onOpenChange(false)}
            size="default"
            className="min-w-[100px]"
          >
            Done
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
