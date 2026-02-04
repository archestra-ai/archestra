"use client";

import type { archestraApiTypes } from "@shared";
import { useCallback, useEffect, useState } from "react";
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
          <DialogTitle>Edit Deployment Yaml</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                <strong className="text-amber-600">Warning:</strong> Only modify
                if you understand Kubernetes deployments. Use "Reset to Default"
                to restore Archestra-generated YAML.
              </p>
              <p>
                Customize the deployment to mount external secrets, volumes, or
                add custom labels and annotations. Environment variables
                configured in the UI take precedence over values defined here.
              </p>
              <p>
                <strong>Placeholders</strong> are replaced at deployment time:{" "}
                <code className="text-xs bg-muted px-1 rounded">
                  ${"{env.KEY}"}
                </code>
                ,{" "}
                <code className="text-xs bg-muted px-1 rounded">
                  ${"{secret.KEY}"}
                </code>
                ,{" "}
                <code className="text-xs bg-muted px-1 rounded">
                  ${"{archestra.*}"}
                </code>{" "}
                (system values like deployment_name, server_id, namespace).
              </p>
              <p>
                <strong>Protected fields</strong> are always overwritten by
                Archestra:{" "}
                <code className="text-xs bg-muted px-1 rounded">
                  mcp-server-id
                </code>{" "}
                and <code className="text-xs bg-muted px-1 rounded">app</code>{" "}
                labels, and the deployment selector.
              </p>
              <p>
                <strong>Transport-specific settings:</strong> Archestra requires{" "}
                <code className="text-xs bg-muted px-1 rounded">
                  stdin: true
                </code>{" "}
                and{" "}
                <code className="text-xs bg-muted px-1 rounded">
                  tty: false
                </code>{" "}
                for stdio servers, and a containerPort for streamable-http
                servers. These are included in the default YAML.
              </p>
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
