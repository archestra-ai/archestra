"use client";

import type { AgentTemplate } from "@shared";
import { getTemplateRequiredMcpServers, isWildcardTool } from "@shared";
import { AgentIcon } from "@/components/agent-icon";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface AgentTemplateDetailsDialogProps {
  open: boolean;
  template: AgentTemplate | null;
  onOpenChange: (open: boolean) => void;
}

export function AgentTemplateDetailsDialog({
  open,
  template,
  onOpenChange,
}: AgentTemplateDetailsDialogProps) {
  if (!template) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-4 text-xl">
            <AgentIcon
              icon={template.icon}
              size={32}
              className="flex h-14 w-14 items-center justify-center rounded-2xl border bg-muted"
            />
            <span>{template.name}</span>
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            {template.description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 px-6 py-6">
          <section className="rounded-xl border bg-muted/20 p-6">
            <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Categories
            </h3>
            <div className="flex flex-wrap gap-2">
              {template.categories.map((category) => (
                <Badge key={category} variant="secondary">
                  {category}
                </Badge>
              ))}
            </div>
          </section>

          <section className="rounded-xl border bg-muted/20 p-6">
            <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Tools
            </h3>
            <div className="flex flex-wrap gap-2">
              {template.tools.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No tools assigned.
                </p>
              ) : template.tools.some(isWildcardTool) ? (
                getTemplateRequiredMcpServers(template.tools).map((name) => (
                  <Badge key={name} variant="outline">
                    All tools from {name}
                  </Badge>
                ))
              ) : (
                template.tools.map((tool) => (
                  <Badge key={tool} variant="outline">
                    {tool}
                  </Badge>
                ))
              )}
            </div>
          </section>

          <section className="rounded-xl border bg-muted/20 p-6">
            <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Labels
            </h3>
            <div className="flex flex-wrap gap-2">
              {template.labels.length === 0 ? (
                <p className="text-sm text-muted-foreground">No labels.</p>
              ) : (
                template.labels.map((label) => (
                  <Badge key={`${label.key}:${label.value}`} variant="outline">
                    {label.key}
                    {": "}
                    {label.value}
                  </Badge>
                ))
              )}
            </div>
          </section>

          <section className="rounded-xl border bg-muted/20 p-6">
            <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              System Prompt
            </h3>
            <p className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-background p-5 text-sm leading-relaxed">
              {template.systemPrompt}
            </p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
