"use client";

import { useRef, useState } from "react";
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
import { useCreateKnowledgeBase } from "@/lib/knowledge/knowledge-base.query";

interface CreateKnowledgeBaseFormValues {
  name: string;
  description: string;
}

export function CreateKnowledgeBaseDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createKnowledgeBase = useCreateKnowledgeBase();
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const labelsRef = useRef<ProfileLabelsRef>(null);

  const form = useForm<CreateKnowledgeBaseFormValues>({
    defaultValues: {
      name: "",
      description: "",
    },
  });

  const handleSubmit = async (values: CreateKnowledgeBaseFormValues) => {
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
    const result = await createKnowledgeBase.mutateAsync({
      name: values.name,
      ...(values.description && { description: values.description }),
      labels: finalLabels,
    });
    if (result) {
      form.reset();
      setLabels([]);
      onOpenChange(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create Knowledge Base"
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
            <Button type="submit" disabled={createKnowledgeBase.isPending}>
              {createKnowledgeBase.isPending
                ? "Creating..."
                : "Create Knowledge Base"}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </Form>
    </FormDialog>
  );
}
