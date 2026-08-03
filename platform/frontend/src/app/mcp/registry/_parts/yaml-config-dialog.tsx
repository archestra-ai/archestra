"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { AlertCircle, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  CATALOG_STALE_WRITE_CODE,
  getCatalogMutationErrorCode,
  useGetDeploymentYamlPreview,
  useUpdateInternalMcpCatalogItem,
} from "@/lib/mcp/internal-mcp-catalog.query";
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

  // Fetch the deployment YAML preview (generates default if not stored)
  const {
    data: yamlPreview,
    isLoading: isLoadingYaml,
    refetch: refetchYamlPreview,
  } = useGetDeploymentYamlPreview(item?.id ?? null);

  // Local state for form fields
  const [deploymentYaml, setDeploymentYaml] = useState("");
  // Track original YAML to detect changes
  const [originalYaml, setOriginalYaml] = useState("");

  // Optimistic-concurrency token for the item as it stood when this editor
  // was filled. A whole deployment document is the widest single-field
  // overwrite in the registry, so it is worth guarding. Taken from the preview
  // response rather than from `item`, so the token and the document on screen
  // always describe the same read.
  const [expectedRevision, setExpectedRevision] = useState<number | null>(null);

  // Check if YAML has been modified
  const hasYamlChanged = deploymentYaml !== originalYaml;

  // Which preview snapshot this editor was filled from. TanStack refetches on
  // window focus, so the query re-delivers while the user is mid-edit; filling
  // again would discard what they typed and re-arm the token against a document
  // they never saw. So a new snapshot is ignored while the editor is dirty:
  // their text and its token both stand, and the save conflicts if the item
  // moved on. A clean editor still adopts it — otherwise this tab would sit on
  // a stale manifest for as long as it stays open. Same guard, same reasons, as
  // the one in `mcp-catalog-form.tsx`.
  const hydratedFromRef = useRef<typeof yamlPreview>(undefined);

  // Initialize form state when YAML preview is loaded.
  //
  // A new snapshot is the only trigger. `hasYamlChanged` is read but must NOT
  // be a dependency: it flips to false the moment a save or a reset
  // re-baselines, which would re-run this against the pre-write snapshot still
  // in cache and undo the re-baseline it just performed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasYamlChanged is read, not a trigger — see above
  useEffect(() => {
    if (!yamlPreview?.yaml) return;
    if (hydratedFromRef.current === yamlPreview) return;
    if (hasYamlChanged) return;
    hydratedFromRef.current = yamlPreview;
    setDeploymentYaml(yamlPreview.yaml);
    setOriginalYaml(yamlPreview.yaml);
    setExpectedRevision(yamlPreview.revision);
  }, [yamlPreview]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // A stale-write 409 leaves the editor holding a document the server has moved
  // past, and the guard above deliberately keeps it there so the user's text
  // survives the failure. That makes the conflict unrecoverable in place —
  // every retry carries the same spent token — so recovery has to be something
  // they choose: this drops their text and re-baselines on the current server
  // document, token included.
  //
  // Reset to default is guarded by the same token and fails the same way, so it
  // raises the same banner instead of a toast of its own — the reload is the
  // only thing that resolves either one.
  const [hasResetConflict, setHasResetConflict] = useState(false);
  const isStaleWriteConflict =
    hasResetConflict ||
    getCatalogMutationErrorCode(updateMutation.error) ===
      CATALOG_STALE_WRITE_CODE;

  const handleResetConflict = useCallback(() => {
    setHasResetConflict(true);
  }, []);

  const handleReloadFromServer = useCallback(async () => {
    const result = await refetchYamlPreview();
    // Status, not `data`: a failed refetch still RESOLVES, keeping the last
    // successful value in `data`. Testing `data` alone would pass on failure
    // and re-baseline onto the very snapshot the conflict is about — throwing
    // away the user's text (nothing else holds it) and clearing the banner, so
    // the next save would 409 again with no visible cause.
    if (result.isError || !result.data?.yaml) {
      toast.error(
        "Couldn't load the latest deployment YAML. Your changes are still here — try again.",
      );
      return;
    }
    const data = result.data;
    hydratedFromRef.current = data;
    setDeploymentYaml(data.yaml);
    setOriginalYaml(data.yaml);
    setExpectedRevision(data.revision);
    setHasResetConflict(false);
    updateMutation.reset();
  }, [refetchYamlPreview, updateMutation.reset]);

  const handleSave = async () => {
    if (!item) return;

    // Only send YAML to server if it was actually modified
    if (!hasYamlChanged) {
      handleClose();
      return;
    }

    try {
      const updated = await updateMutation.mutateAsync({
        id: item.id,
        data: {
          deploymentSpecYaml: deploymentYaml || undefined,
          ...(expectedRevision === null ? {} : { expectedRevision }),
        },
      });

      // Re-baseline on the write that just landed: the saved document becomes
      // the new "unchanged" state and the response's token replaces the one
      // captured at fill time. The invalidated preview delivers both eventually,
      // but not necessarily before the user saves again from the call site that
      // stays mounted (the registry detail page) — that second save would carry
      // a spent token and conflict with this user's own edit.
      setOriginalYaml(deploymentYaml);
      setExpectedRevision(updated.revision);

      handleClose();
    } catch {
      // The mutation's onError surfaces the failure; keep the editor open on
      // the user's text so they can retry or copy it out. Swallowed because
      // DialogForm invokes this unawaited, where a rejection would escape as
      // an unhandled promise rejection.
    }
  };

  const handleYamlChange = useCallback((value: string) => {
    setDeploymentYaml(value);
  }, []);

  // The reset is already persisted, so this is a re-baseline, not an edit: the
  // returned document becomes the new "unchanged" state (disabling Save), and
  // its token replaces the one captured at fill time.
  const handleYamlReset = useCallback(
    ({ yaml, revision }: { yaml: string; revision: number }) => {
      setDeploymentYaml(yaml);
      setOriginalYaml(yaml);
      setExpectedRevision(revision);
      setHasResetConflict(false);
    },
    [],
  );

  // Only show for local servers that have been saved
  const isLocalServer = item?.serverType === "local";

  return (
    <div
      className={
        hideHeader
          ? "flex min-h-0 flex-1 flex-col px-4 py-4"
          : "flex min-h-0 flex-1 flex-col"
      }
    >
      {!hideHeader && (
        <DialogHeader>
          <DialogTitle>K8s Deployment YAML</DialogTitle>
        </DialogHeader>
      )}

      <div className="shrink-0 space-y-2 text-sm text-muted-foreground">
        <p>
          Customize the deployment to mount external secrets, volumes, or add
          custom labels and annotations. Environment variables configured in the
          UI take precedence over values defined here.
        </p>
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors [&[data-state=open]>svg]:rotate-180">
            More details
            <ChevronDown className="h-3 w-3 transition-transform duration-200" />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-2">
            <p>
              <strong>Placeholders</strong> are replaced at deployment time:{" "}
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
              {appName}: mcp-server-id and app labels, and the deployment
              selector.
            </p>
            <p>
              <strong>Transport-specific settings:</strong> {appName} requires{" "}
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
              for streamable-http servers. These are included in the default
              YAML.
            </p>
          </CollapsibleContent>
        </Collapsible>
      </div>

      {isStaleWriteConflict && (
        <Alert
          variant="default"
          className="mt-3 shrink-0 border-yellow-500/50 bg-yellow-50 dark:bg-yellow-950/20"
        >
          <AlertCircle className="h-4 w-4 text-yellow-600" />
          <AlertDescription className="text-yellow-800 dark:text-yellow-200">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>
                Someone else changed this deployment while you were editing.
                Your changes are still here, but saving would overwrite theirs.
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleReloadFromServer}
              >
                Discard mine & reload
              </Button>
            </div>
          </AlertDescription>
        </Alert>
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
              onReset={handleYamlReset}
              expectedRevision={expectedRevision}
              onResetConflict={handleResetConflict}
              isSaved={true}
            />
          ))}

        {(!hideHeader || hasYamlChanged) &&
          (() => {
            const Footer = hideHeader ? DialogStickyFooter : DialogFooter;
            return (
              <Footer>
                <Button variant="outline" onClick={handleClose} type="button">
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={updateMutation.isPending || !hasYamlChanged}
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
