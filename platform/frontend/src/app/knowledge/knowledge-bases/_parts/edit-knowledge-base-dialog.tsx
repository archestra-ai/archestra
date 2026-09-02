"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogForm, DialogStickyFooter } from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useUpdateKnowledgeBase } from "@/lib/knowledge/knowledge-base.query";

type KnowledgeBaseItem = Pick<
  archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"][number],
  "id" | "name" | "description"
> & {
  labels?: archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"][number]["labels"];
};

interface EditKnowledgeBaseFormValues {
  name: string;
  description: string;
}

export function EditKnowledgeBaseDialog({
  knowledgeBase,
  open,
  onOpenChange,
}: {
  knowledgeBase: KnowledgeBaseItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateKnowledgeBase = useUpdateKnowledgeBase();
  const [labels, setLabels] = useState<ProfileLabel[]>(
    knowledgeBase.labels ?? [],
  );
  const labelsRef = useRef<ProfileLabelsRef>(null);

  const form = useForm<EditKnowledgeBaseFormValues>({
    defaultValues: {
      name: knowledgeBase.name,
      description: knowledgeBase.description ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        name: knowledgeBase.name,
        description: knowledgeBase.description ?? "",
      });
      setLabels(knowledgeBase.labels ?? []);
    }
  }, [open, knowledgeBase, form]);

  const handleSubmit = async (values: EditKnowledgeBaseFormValues) => {
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
    const result = await updateKnowledgeBase.mutateAsync({
      id: knowledgeBase.id,
      body: {
        name: values.name,
        description: values.description || null,
        labels: finalLabels,
      },
    });
    if (result) {
      onOpenChange(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Knowledge Base"
      description="Update the knowledge base settings."
      size="medium"
      className="max-w-lg"
    >
      <Form {...form}>
        <DialogForm
          onSubmit={form.handleSubmit(handleSubmit)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            <FormField
              control={form.control}
              name="name"
              rules={{ required: "Name is required" }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="My Knowledge Base" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="A short description of this knowledge base"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <AdvancedLabelsSection
              ref={labelsRef}
              labels={labels}
              onLabelsChange={setLabels}
            />
          </div>

          <DialogStickyFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={updateKnowledgeBase.isPending}>
              {updateKnowledgeBase.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </Form>
    </FormDialog>
  );
}
