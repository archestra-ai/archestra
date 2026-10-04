"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { CircleHelp } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useGetDeploymentYamlPreview,
  useUpdateInternalMcpCatalogItem,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpDeploymentPermission } from "@/lib/mcp/use-mcp-deployment-permission";
import { K8sYamlEditor } from "./k8s-yaml-editor";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

interface YamlConfigDialogProps {
  item: CatalogItem | null;
  onClose: () => void;
}

export function YamlConfigDialog({ item, onClose }: YamlConfigDialogProps) {
  return (
    <Dialog open={!!item} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl h-[85vh] flex flex-col overflow-hidden">
        {item && <YamlConfigContent item={item} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

interface YamlConfigContentProps {
  item: CatalogItem;
  onClose: () => void;
  hideHeader?: boolean;
}

export function YamlConfigContent({
  item,
  onClose,
  hideHeader = false,
}: YamlConfigContentProps) {
  const appName = useAppName();
  const updateMutation = useUpdateInternalMcpCatalogItem();
  const { data: canEditYaml } = useMcpDeploymentPermission(item?.id);

  // Fetch the deployment YAML preview (generates default if not stored)
  const { data: yamlPreview, isLoading: isLoadingYaml } =
    useGetDeploymentYamlPreview(item?.id ?? null);

  // Local state for form fields
  const [deploymentYaml, setDeploymentYaml] = useState("");
  const [isYamlValid, setIsYamlValid] = useState(false);
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
    <div
      className={
        hideHeader
          ? "flex min-h-0 flex-1 flex-col"
          : "flex min-h-0 flex-1 flex-col"
      }
    >
      {!hideHeader && (
        <DialogHeader>
          <DialogTitle>K8s Deployment YAML</DialogTitle>
        </DialogHeader>
      )}

      <DialogForm
        onSubmit={handleSave}
        className="flex min-h-0 flex-1 flex-col"
      >
        {item &&
          isLocalServer &&
          (isLoadingYaml ? (
            <div className="flex min-h-0 flex-1 items-center justify-center w-full text-muted-foreground">
              Loading YAML...
            </div>
          ) : (
            <K8sYamlEditor
              catalogId={item.id}
              value={deploymentYaml}
              onChange={handleYamlChange}
              onValidationChange={setIsYamlValid}
              isSaved={true}
              readOnly={!canEditYaml}
              help={
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="YAML help"
                    >
                      <CircleHelp className="size-3.5" />
                      <span>Help</span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    className="w-96 max-w-[calc(100vw-2rem)] space-y-3 text-sm"
                  >
                    <h3 className="font-medium">Deployment YAML</h3>
                    <p className="text-muted-foreground">
                      Customize volumes, external secrets, labels, and
                      annotations. Environment variables set in Configuration
                      take precedence.
                    </p>
                    <div className="space-y-1">
                      <h4 className="font-medium">Template values</h4>
                      <p className="text-muted-foreground">
                        Use <code>${"{env.KEY}"}</code>,{" "}
                        <code>${"{secret.KEY}"}</code>, or{" "}
                        <code>${"{archestra.KEY}"}</code>. Values are replaced
                        at deployment time.
                      </p>
                      <p className="text-xs font-mono text-muted-foreground break-words">
                        deployment_name, server_id, server_name, docker_image,
                        secret_name, command, arguments, service_account
                      </p>
                    </div>
                    <div className="space-y-1">
                      <h4 className="font-medium">Managed fields</h4>
                      <p className="text-muted-foreground">
                        {appName} controls the deployment selector, system
                        labels, and service account. Configure the service
                        account on the catalog, rather than in YAML.
                      </p>
                    </div>
                    <p className="text-muted-foreground">
                      The default template includes the required transport
                      settings: <code>stdin: true</code> and{" "}
                      <code>tty: false</code> for stdio, or a{" "}
                      <code>containerPort</code> for HTTP.
                    </p>
                  </PopoverContent>
                </Popover>
              }
            />
          ))}

        {canEditYaml &&
          (!hideHeader || hasYamlChanged) &&
          (() => {
            const Footer = hideHeader ? DialogStickyFooter : DialogFooter;
            return (
              <Footer>
                <Button
                  variant="outline"
                  onClick={
                    hideHeader
                      ? () => setDeploymentYaml(originalYaml)
                      : handleClose
                  }
                  type="button"
                  disabled={updateMutation.isPending}
                >
                  <span>{hideHeader ? "Discard" : "Cancel"}</span>
                </Button>
                <Button
                  type="submit"
                  disabled={
                    updateMutation.isPending || !hasYamlChanged || !isYamlValid
                  }
                >
                  {updateMutation.isPending ? "Saving..." : "Save Changes"}
                </Button>
              </Footer>
            );
          })()}
      </DialogForm>
    </div>
  );
}
