"use client";

import type { AgentType, DocsPage } from "@shared";
import { getDocsUrl } from "@shared";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, Bot, ExternalLink, Network, Route } from "lucide-react";
import type { ReactNode } from "react";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const AGENT_TYPE_CONFIG: Record<
  string,
  { icon: LucideIcon; titlePrefix: string }
> = {
  agent: { icon: Bot, titlePrefix: "Connect to" },
  mcp_gateway: { icon: Route, titlePrefix: "Connect via" },
  llm_proxy: { icon: Network, titlePrefix: "Connect via" },
  profile: { icon: Route, titlePrefix: "Connect via" },
};

interface ConnectDialogProps {
  agent: {
    name: string;
    agentType: AgentType;
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
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
            <Icon className="h-4 w-4 text-primary" />
          </div>
          <span>
            {config.titlePrefix} "{agent.name}"
          </span>
        </div>
      }
      size="large"
      className="h-auto max-h-[90vh]"
    >
      <DialogBody className="pb-4">{children}</DialogBody>

      <DialogStickyFooter className="mt-0 sm:justify-between sm:[&>*:first-child]:mr-auto">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          <span>
            Need help? Check our{" "}
            <a
              href={getDocsUrl(docsPage)}
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
      </DialogStickyFooter>
    </FormDialog>
  );
}

export function ConnectDialogSection({
  title,
  description,
  className,
  children,
}: {
  title: string;
  description?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("space-y-4", className)}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}
