"use client";

import type { archestraApiTypes } from "@shared";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useGetDeploymentYamlPreview,
  useUpdateInternalMcpCatalogItem,
} from "@/lib/internal-mcp-catalog.query";
import { K8sYamlEditor } from "./k8s-yaml-editor";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

interface YamlConfigDialogProps {
  item: CatalogItem | null;
  onClose: () => void;
}

export function YamlConfigDialog({ item, onClose }: YamlConfigDialogProps) {
  const updateMutation = useUpdateInternalMcpCatalogItem();

  // Fetch the deployment YAML preview (generates default if not stored)
  const { data: yamlPreview, isLoading: isLoadingYaml } =
    useGetDeploymentYamlPreview(item?.id ?? null);

  // Local state for form fields
  const [deploymentYaml, setDeploymentYaml] = useState("");
  // Track original YAML to detect changes
  const [originalYaml, setOriginalYaml] = useState("");

  // Initialize form state when YAML preview is loaded
  useEffect(() => {
    if (yamlPreview?.yaml) {
      setDeploymentYaml(yamlPreview.yaml);
      setOriginalYaml(yamlPreview.yaml);
    }
  }, [yamlPreview]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // Check if YAML has been modified
  const hasYamlChanged = deploymentYaml !== originalYaml;

  const handleSave = async () => {
    if (!item) return;

    // Only send YAML to server if it was actually modified
    if (!hasYamlChanged) {
      handleClose();
      return;
    }

    await updateMutation.mutateAsync({
      id: item.id,
      data: {
        deploymentSpecYaml: deploymentYaml || undefined,
      },
    });

    handleClose();
  };

  const handleYamlChange = useCallback((value: string) => {
    setDeploymentYaml(value);
  }, []);

  // Only show for local servers that have been saved
  const isLocalServer = item?.serverType === "local";

  return (
    <Dialog open={!!item} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit K8S Deployment Yaml</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                Customize the deployment to mount external secrets, volumes, or
                add custom labels and annotations. Environment variables
                configured in the UI take precedence over values defined here.
              </p>
              <Collapsible>
                <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors [&[data-state=open]>svg]:rotate-180">
                  More details
                  <ChevronDown className="h-3 w-3 transition-transform duration-200" />
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-2 pt-2">
                  <p>
                    <strong>Placeholders</strong> are replaced at deployment
                    time:{" "}
                    <code className="bg-muted/80 text-foreground px-1.5 py-0.5 rounded font-mono text-xs border border-border">
                      ${"{env.*}"}
                    </code>
                    ,{" "}
                    <code className="bg-muted/80 text-foreground px-1.5 py-0.5 rounded font-mono text-xs border border-border">
                      ${"{secret.*}"}
                    </code>
                    ,{" "}
                    <code className="bg-muted/80 text-foreground px-1.5 py-0.5 rounded font-mono text-xs border border-border">
                      ${"{archestra.*}"}
                    </code>
                    . Available archestra values:{" "}
                    <code className="bg-muted/80 text-foreground px-1.5 py-0.5 rounded font-mono text-xs border border-border">
                      deployment_name
                    </code>
                    ,{" "}
                    <code className="bg-muted/80 text-foreground px-1.5 py-0.5 rounded font-mono text-xs border border-border">
                      server_id
                    </code>
                    ,{" "}
                    <code className="bg-muted/80 text-foreground px-1.5 py-0.5 rounded font-mono text-xs border border-border">
                      server_name
                    </code>
                    ,{" "}
                    <code className="bg-muted/80 text-foreground px-1.5 py-0.5 rounded font-mono text-xs border border-border">
                      docker_image
                    </code>
                    ,{" "}
                    <code className="bg-muted/80 text-foreground px-1.5 py-0.5 rounded font-mono text-xs border border-border">
                      secret_name
                    </code>
                    ,{" "}
                    <code className="bg-muted/80 text-foreground px-1.5 py-0.5 rounded font-mono text-xs border border-border">
                      command
                    </code>
                    ,{" "}
                    <code className="bg-muted/80 text-foreground px-1.5 py-0.5 rounded font-mono text-xs border border-border">
                      arguments
                    </code>
                    ,{" "}
                    <code className="bg-muted/80 text-foreground px-1.5 py-0.5 rounded font-mono text-xs border border-border">
                      service_account
                    </code>
                    .
                  </p>
                  <p>
                    <strong>Protected fields</strong> are always overwritten by
                    Archestra: mcp-server-id and app labels, and the deployment
                    selector.
                  </p>
                  <p>
                    <strong>Transport-specific settings:</strong> Archestra
                    requires{" "}
                    <code className="bg-muted/80 text-foreground px-1.5 py-0.5 rounded font-mono text-xs border border-border">
                      stdin: true
                    </code>{" "}
                    and{" "}
                    <code className="bg-muted/80 text-foreground px-1.5 py-0.5 rounded font-mono text-xs border border-border">
                      tty: false
                    </code>{" "}
                    for stdio servers, and a{" "}
                    <code className="bg-muted/80 text-foreground px-1.5 py-0.5 rounded font-mono text-xs border border-border">
                      containerPort
                    </code>{" "}
                    for streamable-http servers. These are included in the
                    default YAML.
                  </p>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </DialogDescription>
        </DialogHeader>

        {item &&
          isLocalServer &&
          (isLoadingYaml ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground">
              Loading YAML...
            </div>
          ) : (
            <K8sYamlEditor
              catalogId={item.id}
              value={deploymentYaml}
              onChange={handleYamlChange}
              isSaved={true}
            />
          ))}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} type="button">
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={updateMutation.isPending}
            type="button"
          >
            {updateMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
