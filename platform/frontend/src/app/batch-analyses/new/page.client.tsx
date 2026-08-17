"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import {
  AnalysisColumnsField,
  type CreateAnalysisFormValues,
  EMPTY_COLUMN,
} from "@/app/batch-analyses/_parts/analysis-columns-field";
import { AnalysisScopeSelector } from "@/app/batch-analyses/_parts/analysis-scope-selector";
import { toColumnKey } from "@/app/batch-analyses/_parts/column-key";
import {
  draftIsSubmittable,
  draftToRows,
  EMPTY_ROW_SOURCE_DRAFT,
  type RowSourceDraft,
  RowSourcePicker,
  useUploadRowSourceFiles,
} from "@/app/batch-analyses/_parts/row-source-picker";
import { AgentSelector } from "@/components/agent-selector";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Stepper, type StepperStep } from "@/components/ui/stepper";
import { useInternalAgents } from "@/lib/agent.query";
import {
  useAddBatchAnalysisRows,
  useCreateBatchAnalysis,
} from "@/lib/batch-analysis/batch-analysis.query";

type WizardStepId = "details" | "columns" | "sources";

const WIZARD_STEPS: StepperStep<WizardStepId>[] = [
  { id: "details", title: "Details" },
  { id: "columns", title: "Columns" },
  { id: "sources", title: "Sources" },
];

const STEP_DESCRIPTIONS: Record<WizardStepId, string> = {
  details: "Name the analysis and pick the agent whose model will run it.",
  columns: "Define the questions to ask of every source.",
  sources: "Add the sources to analyse. You can add more later.",
};

export default function NewBatchAnalysisPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const createAnalysis = useCreateBatchAnalysis();

  /**
   * The analysis is created at the end of the Columns step, because that is
   * when the API has everything it needs. Its id lives in the URL so a refresh
   * on the Sources step resumes against the analysis that already exists
   * instead of silently creating a second one.
   */
  const createdId = searchParams.get("id");
  const stepParam = searchParams.get("step");
  const requestedStep: WizardStepId = WIZARD_STEPS.some(
    (step) => step.id === stepParam,
  )
    ? (stepParam as WizardStepId)
    : "details";
  // Sources is unreachable until the analysis exists — a deep link straight to
  // it has nothing to attach rows to.
  const step: WizardStepId =
    requestedStep === "sources" && !createdId ? "details" : requestedStep;

  const [draft, setDraft] = useState<RowSourceDraft>(EMPTY_ROW_SOURCE_DRAFT);
  const [addingRows, setAddingRows] = useState(false);
  const uploadFiles = useUploadRowSourceFiles();
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");
  const [scopeTeamIds, setScopeTeamIds] = useState<string[]>([]);
  const addRows = useAddBatchAnalysisRows(createdId ?? "");
  const { data: agents = [] } = useInternalAgents();

  const form = useForm<CreateAnalysisFormValues>({
    defaultValues: {
      name: "",
      agentId: "",
      columns: [{ ...EMPTY_COLUMN }],
    },
  });

  const goToStep = (target: WizardStepId, analysisId = createdId) => {
    const params = new URLSearchParams();
    params.set("step", target);
    if (analysisId) params.set("id", analysisId);
    router.replace(`/batch-analyses/new?${params.toString()}`, {
      scroll: false,
    });
  };

  const handleNext = async () => {
    if (step === "details") {
      if (await form.trigger(["name", "agentId"])) goToStep("columns");
      return;
    }
    if (step === "columns") {
      if (!(await form.trigger("columns"))) return;
      const values = form.getValues();
      const taken = new Set<string>();
      const created = await createAnalysis.mutateAsync({
        name: values.name,
        agentId: values.agentId,
        columns: values.columns.map((column, index) => ({
          key: toColumnKey(column.name, index, taken),
          name: column.name,
          prompt: column.prompt,
          format: column.format,
        })),
        scope,
        teamIds: scope === "team" ? scopeTeamIds : [],
      });
      if (created) goToStep("sources", created.id);
    }
  };

  const finish = () => {
    if (createdId) router.push(`/batch-analyses/${createdId}`);
  };

  const handleAddRowsAndFinish = async () => {
    setAddingRows(true);
    try {
      const rows =
        draft.tab === "upload"
          ? (await uploadFiles(draft.files)).rows
          : draftToRows(draft);
      if (rows.length > 0) {
        await addRows.mutateAsync({ rows });
      }
      // Files that failed to upload are not blocking here: the analysis
      // already exists, and the detail page's Add rows dialog reports failures
      // properly. Finishing with what worked beats stranding the wizard.
      finish();
    } finally {
      setAddingRows(false);
    }
  };

  const isCreating = createAnalysis.isPending;

  return (
    <PageLayout
      title="New Analysis"
      description={STEP_DESCRIPTIONS[step]}
      backLink={
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 text-muted-foreground"
          asChild
        >
          <Link href="/batch-analyses">
            <ArrowLeft className="h-4 w-4" />
            Batch Analyses
          </Link>
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <Stepper
          steps={WIZARD_STEPS}
          activeStep={step}
          // Only backwards, and only before the analysis exists: once it is
          // created its name and columns are settled, so offering to "edit"
          // them would be a control that silently does nothing.
          onStepClick={
            createdId
              ? undefined
              : (target) => {
                  const targetIndex = WIZARD_STEPS.findIndex(
                    (s) => s.id === target,
                  );
                  const currentIndex = WIZARD_STEPS.findIndex(
                    (s) => s.id === step,
                  );
                  if (targetIndex < currentIndex) goToStep(target);
                }
          }
        />

        <Form {...form}>
          {step === "details" && (
            <div className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                rules={{ required: "Name is required" }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Vendor questionnaire review"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="agentId"
                rules={{ required: "An agent is required" }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Agent</FormLabel>
                    <AgentSelector
                      mode="single"
                      agents={agents}
                      value={field.value}
                      onValueChange={field.onChange}
                      placeholder="Select an agent"
                      searchPlaceholder="Search agents..."
                      className="w-full"
                    />
                    <FormDescription>
                      Its model and credentials run every cell.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          )}

          {step === "columns" && (
            <div className="space-y-6">
              <AnalysisColumnsField form={form} />
              <AnalysisScopeSelector
                scope={scope}
                onScopeChange={setScope}
                teamIds={scopeTeamIds}
                onTeamIdsChange={setScopeTeamIds}
                description="Who can open, run and edit this analysis. You can change it later."
              />
            </div>
          )}
        </Form>

        {step === "sources" && (
          <RowSourcePicker draft={draft} onDraftChange={setDraft} />
        )}

        <div className="flex justify-end gap-2 border-t pt-4">
          {step === "columns" && (
            <Button
              variant="outline"
              disabled={isCreating}
              onClick={() => goToStep("details")}
            >
              <span>Back</span>
            </Button>
          )}
          {step === "sources" ? (
            <>
              <Button variant="outline" onClick={finish}>
                <span>Skip for now</span>
              </Button>
              <Button
                disabled={addingRows || !draftIsSubmittable(draft)}
                onClick={() => void handleAddRowsAndFinish()}
              >
                <span>
                  {addingRows
                    ? draft.tab === "upload"
                      ? "Uploading…"
                      : "Adding…"
                    : "Add rows"}
                </span>
              </Button>
            </>
          ) : (
            <Button disabled={isCreating} onClick={handleNext}>
              <span>
                {isCreating
                  ? "Creating…"
                  : step === "columns"
                    ? "Create analysis"
                    : "Next"}
              </span>
            </Button>
          )}
        </div>
      </div>
    </PageLayout>
  );
}
