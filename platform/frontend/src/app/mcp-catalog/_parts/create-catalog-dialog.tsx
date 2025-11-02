"use client";

import { useRef, useState } from "react";
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
  useCreateInternalMcpCatalogItem,
  useInternalMcpCatalog,
} from "@/lib/internal-mcp-catalog.query";
import { cn } from "@/lib/utils";
import { ArchestraCatalogTab } from "./archestra-catalog-tab";
import { McpCatalogForm } from "./mcp-catalog-form";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import { transformFormToApiData } from "./mcp-catalog-form.utils";

interface CreateCatalogDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabType = "archestra-catalog" | "remote" | "local";

export function CreateCatalogDialog({
  isOpen,
  onClose,
}: CreateCatalogDialogProps) {
  const [activeTab, setActiveTab] = useState<TabType>("archestra-catalog");
  const createMutation = useCreateInternalMcpCatalogItem();
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const { data: catalogItems } = useInternalMcpCatalog();

  const handleClose = () => {
    setActiveTab("archestra-catalog");
    onClose();
  };

  const onSubmit = async (values: McpCatalogFormValues) => {
    const apiData = transformFormToApiData(values);
    await createMutation.mutateAsync(apiData);
    handleClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add MCP Server</DialogTitle>
          <DialogDescription>
            Add a new MCP server to your private registry from the Archestra
            Catalog or configure a custom server.
          </DialogDescription>
        </DialogHeader>

        <div className="border-b border-border">
          <div className="flex gap-4">
            {[
              { value: "archestra-catalog", label: "Archestra Catalog" },
              { value: "remote", label: "Remote" },
              { value: "local", label: "Local" },
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
          </div>
        </div>

        <div className="min-h-[400px]">
          {activeTab === "archestra-catalog" && (
            <ArchestraCatalogTab
              catalogItems={catalogItems}
              onClose={handleClose}
            />
          )}

          {activeTab === "remote" && (
            <McpCatalogForm
              mode="create"
              onSubmit={onSubmit}
              submitButtonRef={submitButtonRef}
              serverType="remote"
            />
          )}

          {activeTab === "local" && (
            <McpCatalogForm
              mode="create"
              onSubmit={onSubmit}
              submitButtonRef={submitButtonRef}
              serverType="local"
            />
          )}
        </div>

        {activeTab !== "archestra-catalog" && (
          <DialogFooter>
            <Button variant="outline" onClick={handleClose} type="button">
              Cancel
            </Button>
            <Button
              onClick={() => submitButtonRef.current?.click()}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? "Adding..." : "Add Server"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
