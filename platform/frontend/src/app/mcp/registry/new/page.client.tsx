"use client";

import { MCP_CATALOG_CLONE_QUERY_PARAM } from "@archestra/shared";
import {
  ArrowLeft,
  CircleCheck,
  Copy,
  Loader2,
  PencilRuler,
  Search,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { PageBackLink } from "@/components/page-back-link";
import { PageWizard } from "@/components/page-wizard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useGuardedInAppNavigation,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { WizardFooter } from "@/components/wizard-footer";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  getCatalogMutationErrorCode,
  REMOTE_SERVER_URL_NOT_ALLOWED_CODE,
  useCreateInternalMcpCatalogItem,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { useOrganization } from "@/lib/organization.query";
import { ArchestraCatalogTab } from "../_parts/archestra-catalog-tab";
import { SETUP_STEPS } from "../_parts/catalog-setup-wizard";
import { McpCatalogForm } from "../_parts/mcp-catalog-form";
import type { McpCatalogFormValues } from "../_parts/mcp-catalog-form.types";
import {
  buildCloneFormValues,
  transformFormToApiData,
} from "../_parts/mcp-catalog-form.utils";

type SourceSubStep = "source" | "configure";

export default function NewMcpCatalogItemPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const createMutation = useCreateInternalMcpCatalogItem();
  const { data: canCreateRegistry, isPending: isCreatePermissionPending } =
    useHasPermissions({ mcpRegistry: ["create"] });
  const { data: canReadRegistry, isPending: isReadPermissionPending } =
    useHasPermissions({ mcpRegistry: ["read"] });
  const { data: catalogItems } = useInternalMcpCatalog();
  const { data: organization, isPending: isOrganizationPending } =
    useOrganization();

  // When the org disables the online catalog, the source-selection step is
  // skipped entirely and the manual create form opens directly. Fail closed:
  // if the org read is missing (error/stale), honor the disable rather than
  // exposing the public catalog against an admin's intent.
  const catalogEnabled = organization?.onlineMcpCatalogEnabled === true;

  // ?clone=<catalogId> seeds the form from an existing item (used by the
  // Clone action on the item detail page) and skips the source step.
  const cloneSourceId = searchParams.get(MCP_CATALOG_CLONE_QUERY_PARAM);
  const cloneSource = cloneSourceId
    ? catalogItems?.find((item) => item.id === cloneSourceId)
    : undefined;
  // Memoized: the form resets itself whenever its `formValues` prop changes
  // identity, so rebuilding this object on every render (e.g. the re-render
  // from the create mutation entering its pending state) would wipe the
  // user's edits back to the pre-filled clone values.
  const cloneValues = useMemo(
    () => (cloneSource ? buildCloneFormValues(cloneSource) : undefined),
    [cloneSource],
  );

  const [step, setStep] = useState<SourceSubStep>(
    cloneSourceId ? "configure" : "source",
  );
  const [browsingCatalog, setBrowsingCatalog] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const isSavingRef = useRef(false);
  const [created, setCreated] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [prefilledValues, setPrefilledValues] = useState<
    McpCatalogFormValues | undefined
  >(undefined);

  useBeforeUnloadWhileDirty(isDirty);
  const pendingLeaveRef = useRef<
    { kind: "source" } | { kind: "navigate"; href: string } | null
  >(null);
  const guard = useUnsavedChangesGuard({
    isDirty,
    onOpenChange: (open) => {
      if (open) return;
      const pendingLeave = pendingLeaveRef.current;
      pendingLeaveRef.current = null;
      if (pendingLeave?.kind === "source") {
        setIsDirty(false);
        setBrowsingCatalog(false);
        setStep("source");
      } else if (pendingLeave?.kind === "navigate") {
        setIsDirty(false);
        router.push(pendingLeave.href);
      }
    },
  });
  const requestLeave = useCallback(
    (target: { kind: "source" } | { kind: "navigate"; href: string }) => {
      if (isSaving || isSavingRef.current || createMutation.isPending) return;
      pendingLeaveRef.current = target;
      guard.requestClose();
    },
    [createMutation.isPending, guard, isSaving],
  );
  useGuardedInAppNavigation({
    isDirty,
    onRequestNavigate: (href) => requestLeave({ kind: "navigate", href }),
  });
  const isReadPermissionKnown = !isReadPermissionPending;
  useEffect(() => {
    if (!created || !isReadPermissionKnown || canReadRegistry !== true) return;
    router.push(`/mcp/registry/${created.id}/edit?step=test`);
  }, [canReadRegistry, created, isReadPermissionKnown, router]);

  const onSubmit = async (
    values: McpCatalogFormValues,
    form: UseFormReturn<McpCatalogFormValues>,
  ) => {
    if (canCreateRegistry !== true) {
      form.setError("name", {
        type: "permission",
        message: isCreatePermissionPending
          ? "Checking whether you can create MCP servers…"
          : "You do not have permission to create MCP servers.",
      });
      throw new Error("MCP registry create permission is not available");
    }
    const apiData = {
      ...transformFormToApiData(values),
      // Record clone lineage (null for a plain "Add Server").
      clonedFrom: cloneSource ? cloneSource.id : null,
    };
    isSavingRef.current = true;
    setIsSaving(true);
    let createdItem: Awaited<ReturnType<typeof createMutation.mutateAsync>>;
    try {
      createdItem = await createMutation.mutateAsync(apiData, {
        onError: (error) => {
          // Network-policy rejections point at the Server URL — show them
          // inline on that field rather than as a toast (the mutation's shared
          // onError intentionally skips the toast for this code). Without this,
          // e.g. binding a clone to an environment whose egress policy blocks
          // the cloned URL failed with no feedback at all.
          if (
            getCatalogMutationErrorCode(error) ===
            REMOTE_SERVER_URL_NOT_ALLOWED_CODE
          ) {
            form.setError("serverUrl", {
              type: "server",
              message:
                error instanceof Error
                  ? error.message
                  : "Server URL is not allowed by the environment's network policy.",
            });
          }
        },
      });
    } catch (error) {
      isSavingRef.current = false;
      setIsSaving(false);
      throw error;
    }
    if (!createdItem) {
      isSavingRef.current = false;
      setIsSaving(false);
      form.setError("name", {
        type: "server",
        message: "The server was not created. Please try again.",
      });
      throw new Error("MCP registry create returned no item");
    }
    // The mutation has completed, so a success destination must not be
    // intercepted by the stale dirty-state guard.
    setIsDirty(false);
    setCreated({ id: createdItem.id, name: createdItem.name });
  };

  const handleSelectFromCatalog = (formValues: McpCatalogFormValues) => {
    setPrefilledValues(formValues);
    setBrowsingCatalog(false);
    setStep("configure");
  };

  return (
    <PageWizard
      title="Add MCP Server"
      description="Once you add an MCP server here, it will be available for installation."
      backLink={
        created ? undefined : (
          <PageBackLink href="/mcp/registry">MCP Registry</PageBackLink>
        )
      }
      steps={
        !created &&
        !isOrganizationPending &&
        (!catalogEnabled || step === "configure")
          ? SETUP_STEPS
          : undefined
      }
      activeStep={
        !created &&
        !isOrganizationPending &&
        (!catalogEnabled || step === "configure")
          ? "configuration"
          : undefined
      }
    >
      <div className="space-y-6">
        {/* Resolve the catalog setting before rendering so a disabled org never
            flashes the source chooser before falling back to the form. */}
        {created ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {isReadPermissionKnown && canReadRegistry !== true ? (
                  <CircleCheck />
                ) : (
                  <Loader2 className="animate-spin" />
                )}
              </EmptyMedia>
              <EmptyTitle>MCP server created</EmptyTitle>
              <EmptyDescription>
                {isReadPermissionKnown && canReadRegistry !== true
                  ? `“${created.name}” was created. You do not have permission to view it.`
                  : `Opening “${created.name}”…`}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : isOrganizationPending ? null : (
          <>
            {catalogEnabled && step === "source" && !browsingCatalog && (
              <div className="grid gap-4 sm:grid-cols-2">
                <button
                  type="button"
                  className="text-left"
                  onClick={() => {
                    setPrefilledValues(undefined);
                    setStep("configure");
                  }}
                >
                  <Card className="h-full transition-colors hover:border-primary/50 hover:bg-muted/40">
                    <CardHeader>
                      <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                        <PencilRuler className="h-5 w-5" />
                      </div>
                      <CardTitle>Start from scratch</CardTitle>
                      <CardDescription>
                        Configure a custom MCP server manually — remote URL or
                        self-hosted command.
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </button>
                <button
                  type="button"
                  className="text-left"
                  onClick={() => setBrowsingCatalog(true)}
                >
                  <Card className="h-full transition-colors hover:border-primary/50 hover:bg-muted/40">
                    <CardHeader>
                      <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                        <Search className="h-5 w-5" />
                      </div>
                      <CardTitle>Select from Online Catalog</CardTitle>
                      <CardDescription>
                        Pick a server from the public catalog to pre-fill the
                        configuration.
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </button>
              </div>
            )}

            {catalogEnabled && step === "source" && browsingCatalog && (
              <div className="space-y-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setBrowsingCatalog(false)}
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back
                </Button>
                <ArchestraCatalogTab
                  catalogItems={catalogItems}
                  onSelectServer={handleSelectFromCatalog}
                />
              </div>
            )}

            {(!catalogEnabled || step === "configure") && (
              <div className="flex flex-col">
                <McpCatalogForm
                  mode="create"
                  pageSurface
                  onSubmit={onSubmit}
                  onDirtyChange={setIsDirty}
                  formValues={prefilledValues ?? cloneValues}
                  notice={
                    cloneSource ? (
                      <Alert>
                        <Copy className="h-4 w-4" />
                        <AlertDescription>
                          Cloning "{cloneSource.name}" — its configuration
                          (including secrets) is pre-filled here. Adjust
                          anything you like, then save to create a new registry
                          entry.
                        </AlertDescription>
                      </Alert>
                    ) : undefined
                  }
                  footer={({ hasBlockingErrors }) => (
                    <WizardFooter>
                      {cloneSourceId || !catalogEnabled ? (
                        <Button
                          variant="outline"
                          type="button"
                          onClick={() =>
                            requestLeave({
                              kind: "navigate",
                              href: "/mcp/registry",
                            })
                          }
                          disabled={isSaving || createMutation.isPending}
                        >
                          Cancel
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          type="button"
                          onClick={() => requestLeave({ kind: "source" })}
                          disabled={isSaving || createMutation.isPending}
                        >
                          <ArrowLeft className="h-4 w-4" />
                          Back
                        </Button>
                      )}
                      <Button
                        type="submit"
                        disabled={
                          createMutation.isPending ||
                          hasBlockingErrors ||
                          canCreateRegistry !== true
                        }
                      >
                        {createMutation.isPending
                          ? "Adding..."
                          : isCreatePermissionPending
                            ? "Checking permission..."
                            : "Add Server"}
                      </Button>
                    </WizardFooter>
                  )}
                />
              </div>
            )}
          </>
        )}
      </div>
      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={guard.keepEditing}
        onDiscard={guard.discardChanges}
      />
    </PageWizard>
  );
}
