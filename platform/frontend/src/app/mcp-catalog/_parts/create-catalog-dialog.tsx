"use client";

import type { archestraApiTypes } from "@shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LOCAL_MCP_DISABLED_MESSAGE } from "@/consts";
import { useFeatureFlag } from "@/lib/features.hook";
import {
  useCreateInternalMcpCatalogItem,
  useInternalMcpCatalog,
} from "@/lib/internal-mcp-catalog.query";
import { cn } from "@/lib/utils";
import { ArchestraCatalogTab } from "./archestra-catalog-tab";
import { McpCatalogForm } from "./mcp-catalog-form";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import { transformFormToApiData } from "./mcp-catalog-form.utils";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

interface CreateCatalogDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (createdItem: CatalogItem) => void;
}

type TabType = "archestra-catalog" | "remote" | "local";

export function CreateCatalogDialog({
  isOpen,
  onClose,
  onSuccess,
}: CreateCatalogDialogProps) {
  const [activeTab, setActiveTab] = useState<TabType>("archestra-catalog");
  const createMutation = useCreateInternalMcpCatalogItem();
  const { data: catalogItems } = useInternalMcpCatalog();
  const isLocalMcpEnabled = useFeatureFlag("orchestrator-k8s-runtime");

  const handleClose = () => {
    setActiveTab("archestra-catalog");
    onClose();
  };

  const onSubmit = async (values: McpCatalogFormValues) => {
    const apiData = transformFormToApiData(values);
    const createdItem = await createMutation.mutateAsync(apiData);
    handleClose();
    if (createdItem) {
      onSuccess?.(createdItem);
    }
  };

  const footer = (
    <DialogFooter className="flex-shrink-0">
      <Button variant="outline" onClick={handleClose} type="button">
        Cancel
      </Button>
      <Button type="submit" disabled={createMutation.isPending}>
        {createMutation.isPending ? "Adding..." : "Add Server"}
      </Button>
    </DialogFooter>
  );

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-5xl h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Add MCP Server to the Private Registry</DialogTitle>
          <DialogDescription>
            Once you add an MCP server here, it will be available for
            installation.
          </DialogDescription>
        </DialogHeader>

        <div className="border-b border-border">
          <div className="flex gap-4">
            {[
              { value: "archestra-catalog", label: "Online Catalog" },
              {
                value: "remote",
                label: "Remote (orchestrated not by Archestra)",
              },
            ].map((tab) => (
              <button
                type="button"
                key={tab.value}
                onClick={() => setActiveTab(tab.value as TabType)}
                className={cn(
                  "relative pb-3 text-sm font-medium transition-colors hover:text-foreground",
                  activeTab === tab.value
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {tab.label}
                {activeTab === tab.value && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                )}
              </button>
            ))}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() =>
                    isLocalMcpEnabled && setActiveTab("local" as TabType)
                  }
                  disabled={!isLocalMcpEnabled}
                  className={cn(
                    "relative pb-3 text-sm font-medium transition-colors",
                    !isLocalMcpEnabled
                      ? "text-muted-foreground/50 cursor-not-allowed"
                      : "hover:text-foreground",
                    activeTab === "local"
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  Self-hosted (orchestrated by Archestra in K8s)
                  {activeTab === "local" && (
                    <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                  )}
                </button>
              </TooltipTrigger>
              {!isLocalMcpEnabled && (
                <TooltipContent>
                  <p className="max-w-xs">{LOCAL_MCP_DISABLED_MESSAGE}</p>
                </TooltipContent>
              )}
            </Tooltip>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {activeTab === "archestra-catalog" && (
            <ArchestraCatalogTab
              catalogItems={catalogItems}
              onClose={handleClose}
              onSuccess={onSuccess}
            />
          )}

          {activeTab === "remote" && (
            <McpCatalogForm
              mode="create"
              onSubmit={onSubmit}
              serverType="remote"
              footer={footer}
            />
          )}

          {activeTab === "local" && (
            <McpCatalogForm
              mode="create"
              onSubmit={onSubmit}
              serverType="local"
              footer={footer}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
