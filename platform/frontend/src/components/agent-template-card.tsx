"use client";

import type { AgentTemplate } from "@shared";
import { getTemplateRequiredMcpServers, isWildcardTool } from "@shared";
import { Pencil } from "lucide-react";
import { AgentIcon } from "@/components/agent-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface AgentTemplateCardProps {
  template: AgentTemplate;
  /** Number of unresolved catalogs (missing MCP server installs) */
  missingCatalogs?: number;
  /** Called when the user clicks "Use Template" */
  onUse: (template: AgentTemplate) => void;
  /** Called when the user clicks "Preview" */
  onPreview?: (template: AgentTemplate) => void;
  /** Called when the user clicks "Edit Template" */
  onEdit?: (template: AgentTemplate) => void;
  className?: string;
}

export function AgentTemplateCard({
  template,
  missingCatalogs = 0,
  onUse,
  onPreview,
  onEdit,
  className,
}: AgentTemplateCardProps) {
  const hasWildcard = template.tools.some(isWildcardTool);
  const toolCount = template.tools.length;
  const primaryCategory = template.categories[0] ?? "general";
  const mcpServers = getTemplateRequiredMcpServers(template.tools);

  return (
    <Card
      className={cn(
        "group flex min-h-[280px] flex-col overflow-hidden border-muted/70 bg-gradient-to-b from-background to-muted/20 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg",
        className,
      )}
    >
      <CardContent className="flex flex-1 flex-col gap-5 p-6">
        <div className="flex items-center gap-4">
          <AgentIcon
            icon={template.icon}
            size={28}
            className="flex h-12 w-12 items-center justify-center rounded-2xl border bg-background shadow-sm"
          />
          <div className="flex-1">
            <h3 className="text-base font-semibold leading-tight">
              {template.name}
            </h3>
            <span className="text-xs text-muted-foreground capitalize">
              {primaryCategory}
            </span>
          </div>
        </div>

        <p className="line-clamp-3 text-muted-foreground text-sm leading-relaxed">
          {template.description}
        </p>

        <div className="mt-auto flex flex-wrap items-center gap-2">
          {hasWildcard ? (
            mcpServers.map((name) => (
              <Badge key={name} variant="secondary" className="rounded-full">
                All {name} tools
              </Badge>
            ))
          ) : (
            <Badge variant="secondary" className="rounded-full">
              {toolCount} tool{toolCount !== 1 ? "s" : ""}
            </Badge>
          )}
          {!hasWildcard &&
            mcpServers.map((name) => (
              <Badge
                key={name}
                variant="outline"
                className="rounded-full text-xs border-primary/30 text-primary"
              >
                MCP: {name}
              </Badge>
            ))}
          {missingCatalogs > 0 && (
            <Badge
              variant="outline"
              className="text-amber-600 border-amber-300 dark:border-amber-700 text-xs"
            >
              {missingCatalogs} server{missingCatalogs !== 1 ? "s" : ""} needed
            </Badge>
          )}
        </div>
      </CardContent>

      <CardFooter className="flex flex-col gap-2 border-t bg-muted/20 px-6 py-4">
        <div className="flex gap-3 w-full">
          {onPreview && (
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => onPreview(template)}
            >
              Preview
            </Button>
          )}
          <Button size="sm" className="flex-1" onClick={() => onUse(template)}>
            Use Template
          </Button>
        </div>
        {onEdit && (
          <Button
            size="sm"
            variant="outline"
            className="w-full gap-2"
            onClick={() => onEdit(template)}
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit Template
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
