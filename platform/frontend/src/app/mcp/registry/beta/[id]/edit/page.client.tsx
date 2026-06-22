"use client";

import { ArrowLeft, ArrowRight, PackageX } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import {
  SETUP_STEPS,
  type SetupStepId,
  SetupStepper,
  TestConnectionStep,
  ToolsAndGuardrailsStep,
  useTestConnectionTarget,
} from "../../_parts/catalog-setup-wizard";
import { EditCatalogContent } from "../../_parts/edit-catalog-dialog";
import type { CatalogItem } from "../../_parts/mcp-server-card";

export function McpCatalogItemEditPage({ id }: { id: string }) {
  const { data: catalogItems, isPending } = useInternalMcpCatalog({});
  const item = catalogItems?.find((catalogItem) => catalogItem.id === id);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 text-muted-foreground"
        asChild
      >
        <Link href={`/mcp/registry/beta/${id}`}>
          <ArrowLeft className="h-4 w-4" />
          Back to server
        </Link>
      </Button>

      {isPending ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      ) : !item ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageX />
            </EmptyMedia>
            <EmptyTitle>Server not found</EmptyTitle>
            <EmptyDescription>
              This MCP server is not in the registry. It may have been removed.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <SetupWizard item={item} />
      )}
    </div>
  );
}

function SetupWizard({ item }: { item: CatalogItem }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const stepParam = searchParams.get("step");
  const step: SetupStepId = SETUP_STEPS.some((s) => s.id === stepParam)
    ? (stepParam as SetupStepId)
    : // "guardrails" merged into "tools"; keep old deep links working.
      stepParam === "guardrails"
      ? "tools"
      : "configuration";
  const stepIndex = SETUP_STEPS.findIndex((s) => s.id === step);
  const nextStep = SETUP_STEPS[stepIndex + 1];
  const prevStep = SETUP_STEPS[stepIndex - 1];

  const goToStep = (target: SetupStepId) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("step", target);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  // Without a connection the test step's own Install button is the step's
  // single CTA — hide the Next button so the two don't compete.
  const { target: testTarget } = useTestConnectionTarget(item);
  const hideNext = step === "test" && !testTarget;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <McpCatalogIcon icon={item.icon} catalogId={item.id} size={32} />
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            Edit {item.name}
            <Badge variant="secondary" className="capitalize">
              {item.serverType}
            </Badge>
          </h1>
          <p className="text-sm text-muted-foreground">
            Configure the server, test the connection, review its tools, and set
            guardrails.
          </p>
        </div>
      </div>

      <SetupStepper activeStep={step} onStepClick={goToStep} />

      {step === "configuration" && (
        <div className="flex flex-col rounded-lg border">
          <EditCatalogContent
            item={item}
            onClose={() => {}}
            keepOpenOnSave
            // One primary CTA: while the form is dirty it saves; once clean it
            // advances the wizard. Discard is the secondary escape hatch.
            footer={({ isDirty, isSaving, hasBlockingErrors, onReset }) => (
              <div className="sticky bottom-0 z-10 flex items-center justify-between gap-2 rounded-b-lg border-t bg-background px-6 py-4">
                <div>
                  {isDirty && (
                    <Button
                      variant="outline"
                      type="button"
                      onClick={onReset}
                      disabled={isSaving}
                    >
                      Discard changes
                    </Button>
                  )}
                </div>
                {isDirty ? (
                  <Button
                    type="submit"
                    disabled={isSaving || hasBlockingErrors}
                  >
                    {isSaving ? "Saving..." : "Save Changes"}
                  </Button>
                ) : (
                  <Button type="button" onClick={() => goToStep("test")}>
                    Test Connection
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                )}
              </div>
            )}
          />
        </div>
      )}

      {step === "test" && <TestConnectionStep item={item} />}

      {step === "tools" && <ToolsAndGuardrailsStep item={item} />}

      {/* The configuration step carries its CTA inside the form footer. */}
      {step !== "configuration" && (
        <div className="flex items-center justify-between">
          <div>
            {prevStep && (
              <Button variant="outline" onClick={() => goToStep(prevStep.id)}>
                <ArrowLeft className="h-4 w-4" />
                {prevStep.title}
              </Button>
            )}
          </div>
          {nextStep ? (
            !hideNext && (
              <Button onClick={() => goToStep(nextStep.id)}>
                {nextStep.title}
                <ArrowRight className="h-4 w-4" />
              </Button>
            )
          ) : (
            <Button
              onClick={() => router.push(`/mcp/registry/beta/${item.id}`)}
            >
              Finish
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
