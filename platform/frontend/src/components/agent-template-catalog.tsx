"use client";

import type { AgentTemplate } from "@shared";
import { useMemo, useState } from "react";
import { AgentTemplateCard } from "@/components/agent-template-card";
import { LoadingSpinner } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAgentTemplates } from "@/lib/agent-templates.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils";

export interface AgentTemplateCatalogProps {
  /** Called when the user selects a template to use */
  onSelectTemplate: (template: AgentTemplate) => void;
  /** Called when the user clicks Preview on a template */
  onPreviewTemplate?: (template: AgentTemplate) => void;
  /** Called when the user clicks Edit Template */
  onEditTemplate?: (template: AgentTemplate) => void;
  className?: string;
}

export function AgentTemplateCatalog({
  onSelectTemplate,
  onPreviewTemplate,
  onEditTemplate,
  className,
}: AgentTemplateCatalogProps) {
  const appName = useAppName();
  const { data: templates, isPending } = useAgentTemplates();
  const [search, setSearch] = useState("");
  const categories = useMemo(() => {
    const values = new Set<string>();
    for (const template of templates ?? []) {
      for (const category of template.categories) {
        values.add(category);
      }
    }
    return ["all", ...values];
  }, [templates]);
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

  const filtered = (templates ?? []).filter((t) => {
    const matchesCategory =
      selectedCategory === "all" || t.categories.includes(selectedCategory);
    const matchesSearch =
      !search ||
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.description.toLowerCase().includes(search.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  if (isPending) {
    return (
      <div className="flex items-center justify-center py-16">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <div className="rounded-2xl border bg-muted/30 p-6">
        <div className="mb-4 space-y-2">
          <p className="font-semibold text-base">Start from a ready agent</p>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Pick a template. {appName} creates the agent, assigns available
            tools, and guides any missing MCP setup.
          </p>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex-1">
            <Input
              placeholder="Search templates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {categories.map((category) => (
              <Button
                key={category}
                size="sm"
                variant={selectedCategory === category ? "default" : "outline"}
                onClick={() => setSelectedCategory(category)}
                className="h-8"
              >
                {category === "all" ? "All" : category}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {search || selectedCategory !== "all"
            ? "No templates match your filters."
            : "No templates available."}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((template) => (
            <AgentTemplateCard
              key={template.id}
              template={template}
              onUse={onSelectTemplate}
              onPreview={onPreviewTemplate}
              onEdit={onEditTemplate}
            />
          ))}
        </div>
      )}
    </div>
  );
}
