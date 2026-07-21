"use client";

import { MCP_CATALOG_CLONE_QUERY_PARAM } from "@archestra/shared";
import { ArrowLeft, Copy, PencilRuler, Search } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { LoadingSpinner } from "@/components/loading";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  getCatalogMutationErrorCode,
  REMOTE_SERVER_URL_NOT_ALLOWED_CODE,
  useCreateInternalMcpCatalogItem,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { useOrganization } from "@/lib/organization.query";
import { ArchestraCatalogTab } from "../_parts/archestra-catalog-tab";
import { SetupStepper } from "../_parts/catalog-setup-wizard";
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
  const [prefilledValues, setPrefilledValues] = useState<
    McpCatalogFormValues | undefined
  >(undefined);

  const onSubmit = (
    values: McpCatalogFormValues,
    form: UseFormReturn<McpCatalogFormValues>,
  ) => {
    const apiData = {
      ...transformFormToApiData(values),
      // Record clone lineage (null for a plain "Add Server").
      clonedFrom: cloneSource ? cloneSource.id : null,
    };
    createMutation.mutate(apiData, {
      onSuccess: (createdItem) => {
        if (!createdItem) return;
        // Continue the setup wizard on the created item: test the connection,
        // review tools, configure guardrails.
        router.push(`/mcp/registry/${createdItem.id}/edit?step=test`);
      },
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
  };

  const handleSelectFromCatalog = (formValues: McpCatalogFormValues) => {
    setPrefilledValues(formValues);
    setBrowsingCatalog(false);
    setStep("configure");
  };

  // Resolve the catalog setting before rendering so a disabled org never
  // flashes the source chooser before falling back to the form.
  if (isOrganizationPending) {
    return <LoadingSpinner className="my-8" />;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 text-muted-foreground"
        asChild
      >
        <Link href="/mcp/registry">
          <ArrowLeft className="h-4 w-4" />
          MCP Registry
        </Link>
      </Button>

      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Add MCP Server to the Private Registry
        </h1>
        <p className="text-sm text-muted-foreground">
          Once you add an MCP server here, it will be available for
          installation.
        </p>
      </div>

      <SetupStepper activeStep="configuration" />

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
        <div className="flex flex-col rounded-lg border">
          <McpCatalogForm
            mode="create"
            onSubmit={onSubmit}
            formValues={prefilledValues ?? cloneValues}
            notice={
              cloneSource ? (
                <Alert>
                  <Copy className="h-4 w-4" />
                  <AlertDescription>
                    Cloning "{cloneSource.name}" — its configuration (including
                    secrets) is pre-filled here. Adjust anything you like, then
                    save to create a new registry entry.
                  </AlertDescription>
                </Alert>
              ) : undefined
            }
            footer={({ hasBlockingErrors }) => (
              <div className="sticky bottom-0 z-10 flex items-center justify-between gap-2 rounded-b-lg border-t bg-background px-6 py-4">
                {cloneSourceId || !catalogEnabled ? (
                  <Button variant="outline" type="button" asChild>
                    <Link href="/mcp/registry">Cancel</Link>
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => setStep("source")}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </Button>
                )}
                <Button
                  type="submit"
                  disabled={createMutation.isPending || hasBlockingErrors}
                >
                  {createMutation.isPending ? "Adding..." : "Add Server"}
                </Button>
              </div>
            )}
          />
        </div>
      )}
    </div>
  );
}
