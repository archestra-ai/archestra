"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { createdByFact } from "@/components/created-by-cell";
import { DetailFacts } from "@/components/detail-facts";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
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
  createdBy?: archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"][number]["createdBy"];
  labels?: archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"][number]["labels"];
};

type EditKnowledgeBaseFormValues = {
  name: string;
  description: string;
};

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
  // The permissions block keeps its edits in its own form. This dialog's
  // Save Changes is the only Save on screen, so it commits them too.
  const permissionsSave = useRef<(() => Promise<void>) | null>(null);
  const registerPermissionsSave = useCallback(
    (save: (() => Promise<void>) | null) => {
      permissionsSave.current = save;
    },
    [],
  );
  const [permissionsDirty, setPermissionsDirty] = useState(false);

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
    await permissionsSave.current?.();
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
    <Form {...form}>
      <StandardFormDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Edit Knowledge Base"
        description="Update the knowledge base settings."
        isDirty={permissionsDirty}
        onSubmit={form.handleSubmit(handleSubmit)}
        bodyClassName="space-y-4"
        footer={
          <>
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
          </>
        }
      >
        <DetailFacts facts={[createdByFact(knowledgeBase.createdBy)]} />
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

        <ResourceAccessSection
          resource="knowledgeBase"
          id={knowledgeBase.id}
          registerSave={registerPermissionsSave}
          onDirtyChange={setPermissionsDirty}
        />
        <AdvancedLabelsSection
          ref={labelsRef}
          labels={labels}
          onLabelsChange={setLabels}
        />
      </StandardFormDialog>
    </Form>
  );
}
