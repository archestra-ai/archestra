"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import {
  AnalysisColumnsField,
  type CreateAnalysisFormValues,
} from "@/app/batch-analyses/_parts/analysis-columns-field";
import { AnalysisScopeSelector } from "@/app/batch-analyses/_parts/analysis-scope-selector";
import { toColumnKey } from "@/app/batch-analyses/_parts/column-key";
import { TemplatePicker } from "@/app/batch-analyses/_parts/template-picker";
import { AgentSelector } from "@/components/agent-selector";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useInternalAgents } from "@/lib/agent.query";
import {
  type BatchAnalysisSummary,
  useUpdateBatchAnalysis,
} from "@/lib/batch-analysis/batch-analysis.query";

/**
 * Edits an analysis's whole configuration.
 *
 * Everything the wizard can set is editable here, using the wizard's own
 * fields: a mistake made while creating should be fixable in place, not a
 * reason to start over. Rows are not part of it — they are managed on the
 * analysis itself, where you can see what you are adding to.
 */
export function EditAnalysisDialog({
  open,
  onOpenChange,
  analysis,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  analysis?: BatchAnalysisSummary;
}) {
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);

  const { data: agents } = useInternalAgents();
  const updateAnalysis = useUpdateBatchAnalysis();

  const form = useForm<CreateAnalysisFormValues>({
    defaultValues: { name: "", agentId: "", columns: [] },
  });

  // Re-seed on open so editing a second analysis never shows the first one's
  // configuration.
  useEffect(() => {
    if (!open || !analysis) return;
    form.reset({
      name: analysis.name,
      agentId: analysis.agentId,
      columns: analysis.columns.map((column) => ({
        key: column.key,
        name: column.name,
        prompt: column.prompt,
        format: column.format,
        flag: column.flag ?? false,
      })),
    });
    setScope(analysis.scope);
    setTeamIds(analysis.teamIds);
  }, [open, analysis, form]);

  const handleSubmit = form.handleSubmit((values) => {
    if (!analysis) return;
    updateAnalysis.mutate(
      {
        analysisId: analysis.id,
        body: {
          name: values.name.trim(),
          agentId: values.agentId,
          // An existing column keeps its key so the answers already written
          // against it stay attached, even if it is renamed; only a newly
          // added column derives one, disambiguated against the keys in use.
          columns: (() => {
            const taken = new Set(
              values.columns
                .map((column) => column.key)
                .filter((key): key is string => !!key),
            );
            return values.columns.map((column, index) => ({
              key: column.key ?? toColumnKey(column.name, index, taken),
              name: column.name.trim(),
              prompt: column.prompt.trim(),
              format: column.format,
              flag: column.flag || undefined,
            }));
          })(),
          scope,
          teamIds: scope === "team" ? teamIds : [],
        },
      },
      { onSuccess: () => onOpenChange(false) },
    );
  });

  const values = form.watch();
  const canSubmit =
    values.name?.trim().length > 0 &&
    !!values.agentId &&
    values.columns?.length > 0 &&
    values.columns.every(
      (column) => column.name.trim() && column.prompt.trim(),
    ) &&
    (scope !== "team" || teamIds.length > 0) &&
    !updateAnalysis.isPending;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit analysis"
      description="Changing the columns does not re-run the analysis; existing answers stay until you run it again."
      size="medium"
    >
      <Form {...form}>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <FormField
            control={form.control}
            name="name"
            rules={{ required: "Name is required" }}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="agentId"
            rules={{ required: "Agent is required" }}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Agent</FormLabel>
                <FormControl>
                  <AgentSelector
                    mode="single"
                    agents={agents ?? []}
                    value={field.value}
                    onValueChange={field.onChange}
                    placeholder="Select an agent"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <AnalysisColumnsField form={form} />
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-xs">
              Add a template&apos;s columns — appended to the ones above, so
              existing answers stay attached to their columns.
            </p>
            <TemplatePicker
              compact
              onPick={(template) =>
                form.setValue(
                  "columns",
                  [
                    ...form.getValues("columns"),
                    ...template.columns.map((column) => ({
                      name: column.name,
                      prompt: column.prompt,
                      format: column.format,
                      flag: column.flag ?? false,
                    })),
                  ],
                  { shouldDirty: true },
                )
              }
            />
          </div>

          <AnalysisScopeSelector
            scope={scope}
            onScopeChange={setScope}
            teamIds={teamIds}
            onTeamIdsChange={setTeamIds}
          />
        </div>

        <DialogStickyFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <span>Cancel</span>
          </Button>
          <Button disabled={!canSubmit} onClick={() => void handleSubmit()}>
            <span>{updateAnalysis.isPending ? "Saving…" : "Save"}</span>
          </Button>
        </DialogStickyFooter>
      </Form>
    </FormDialog>
  );
}
