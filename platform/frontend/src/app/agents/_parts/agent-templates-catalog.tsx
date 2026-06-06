"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { AgentIcon } from "@/components/agent-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCreateProfile } from "@/lib/agent.query";
import {
  AGENT_TEMPLATES,
  type AgentTemplate,
  buildCreateAgentBodyFromTemplate,
} from "./agent-templates";

interface AgentTemplatesCatalogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Quickstart catalog of pre-built agent templates (issue #3858). Picking a
 * template creates a fully-configured agent in one click and, when the template
 * recommends MCP servers, points the user at the MCP registry to install them.
 */
export function AgentTemplatesCatalog({
  open,
  onOpenChange,
}: AgentTemplatesCatalogProps) {
  const router = useRouter();
  const createAgent = useCreateProfile();
  const [creatingId, setCreatingId] = useState<string | null>(null);

  const handleUseTemplate = async (template: AgentTemplate) => {
    setCreatingId(template.id);
    try {
      const created = await createAgent.mutateAsync(
        buildCreateAgentBodyFromTemplate(template),
      );
      if (!created?.id) return;

      toast.success(
        `Created "${created.name}" from the ${template.name} template`,
      );
      onOpenChange(false);

      if (template.recommendedMcpServers.length > 0) {
        const names = template.recommendedMcpServers
          .map((s) => s.name)
          .join(", ");
        toast.info(`This agent works best with: ${names}`, {
          action: {
            label: "Install MCP servers",
            onClick: () => router.push("/mcp/registry"),
          },
        });
      }

      router.refresh();
    } finally {
      setCreatingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            Start from a template
          </DialogTitle>
          <DialogDescription>
            Spin up a fully-configured agent — system prompt, suggested prompts,
            and recommended MCP servers — in a single click.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {AGENT_TEMPLATES.map((template) => {
            const isCreating = creatingId === template.id;
            const isDisabled = creatingId !== null;
            return (
              <div
                key={template.id}
                className="flex flex-col rounded-lg border p-4 gap-2"
              >
                <div className="flex items-center gap-2">
                  <AgentIcon icon={template.icon} />
                  <span className="font-medium">{template.name}</span>
                  <Badge variant="secondary" className="ml-auto">
                    {template.category}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground flex-1">
                  {template.description}
                </p>
                {template.recommendedMcpServers.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {template.recommendedMcpServers.map((server) => (
                      <Badge key={server.catalogName} variant="outline">
                        {server.name}
                      </Badge>
                    ))}
                  </div>
                )}
                <Button
                  className="mt-1"
                  size="sm"
                  disabled={isDisabled}
                  onClick={() => handleUseTemplate(template)}
                >
                  {isCreating ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Creating…
                    </>
                  ) : (
                    "Create agent"
                  )}
                </Button>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
