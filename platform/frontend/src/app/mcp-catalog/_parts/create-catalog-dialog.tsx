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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCreateInternalMcpCatalogItem } from "@/lib/internal-mcp-catalog.query";
import {
  McpCatalogForm,
  type McpCatalogFormValues,
  transformFormToApiData,
} from "./mcp-catalog-form";

interface CreateCatalogDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreateCatalogDialog({
  isOpen,
  onClose,
}: CreateCatalogDialogProps) {
  const [activeTab, setActiveTab] = useState<"remote" | "local">("remote");
  const createMutation = useCreateInternalMcpCatalogItem();
  const submitButtonRef = useRef<HTMLButtonElement>(null);

  const handleClose = () => {
    setActiveTab("remote");
    onClose();
  };

  const onSubmit = async (values: McpCatalogFormValues) => {
    const apiData = transformFormToApiData(values);
    await createMutation.mutateAsync(apiData);
    handleClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add MCP Server Using Config</DialogTitle>
          <DialogDescription>
            Add a new MCP server to your private registry.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => {
            setActiveTab(v as "remote" | "local");
          }}
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="remote">Remote</TabsTrigger>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger onClick={(e) => e.preventDefault()}>
                  <TabsTrigger value="local" disabled>
                    Local
                  </TabsTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Local MCP Servers will be supported soon</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </TabsList>

          <TabsContent value="remote" className="space-y-4 mt-4">
            <McpCatalogForm
              mode="create"
              onSubmit={onSubmit}
              submitButtonRef={submitButtonRef}
            />
          </TabsContent>

          <TabsContent value="local">
            <div className="text-center py-8 text-muted-foreground">
              Local MCP servers will be supported soon
            </div>
          </TabsContent>
        </Tabs>

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
      </DialogContent>
    </Dialog>
  );
}
