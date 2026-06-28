"use client";

import { MCP_CATALOG_CLONE_QUERY_PARAM } from "@archestra/shared";
import { ArrowLeft, Copy, PencilRuler, Search } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  useCreateInternalMcpCatalogItem,
  useInternalMcpCatalog,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { McpCatalogForm } from "../../_parts/mcp-catalog-form";
import type { McpCatalogFormValues } from "../../_parts/mcp-catalog-form.types";
import {
  buildCloneFormValues,
  transformFormToApiData,
} from "../../_parts/mcp-catalog-form.utils";
import { ArchestraCatalogTab } from "../_parts/archestra-catalog-tab";
import { SetupStepper } from "../_parts/catalog-setup-wizard";

type SourceSubStep = "source" | "configure";

export default function NewMcpCatalogItemPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const createMutation = useCreateInternalMcpCatalogItem();
  const { data: catalogItems } = useInternalMcpCatalog();

  // ?clone=<catalogId> seeds the form from an existing item (used by the
  // Clone action on the item detail page) and skips the source step.
  const cloneSourceId = searchParams.get(MCP_CATALOG_CLONE_QUERY_PARAM);
  const cloneSource = cloneSourceId
    ? catalogItems?.find((item) => item.id === cloneSourceId)
    : undefined;
  const cloneValues = cloneSource
    ? buildCloneFormValues(cloneSource)
    : undefined;

  const [step, setStep] = useState<SourceSubStep>(
    cloneSourceId ? "configure" : "source",
  );
  const [browsingCatalog, setBrowsingCatalog] = useState(false);
  const [prefilledValues, setPrefilledValues] = useState<
    McpCatalogFormValues | undefined
  >(undefined);

  const onSubmit = async (values: McpCatalogFormValues) => {
    const apiData = {
      ...transformFormToApiData(values),
      // Record clone lineage (null for a plain "Add Server").
      clonedFrom: cloneSource ? cloneSource.id : null,
    };
    const createdItem = await createMutation.mutateAsync(apiData);
    if (!createdItem) return;

    // Continue the setup wizard on the created item: test the connection,
    // review tools, configure guardrails.
    router.push(`/mcp/registry/beta/${createdItem.id}/edit?step=test`);
  };

  const handleSelectFromCatalog = (formValues: McpCatalogFormValues) => {
    setPrefilledValues(formValues);
    setBrowsingCatalog(false);
    setStep("configure");
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 text-muted-foreground"
        asChild
      >
        <Link href="/mcp/registry/beta">
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

      {step === "source" && !browsingCatalog && (
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

      {step === "source" && browsingCatalog && (
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

      {step === "configure" && (
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
                {cloneSourceId ? (
                  <Button variant="outline" type="button" asChild>
                    <Link href="/mcp/registry/beta">Cancel</Link>
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
