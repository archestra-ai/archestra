"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Database } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { createdByFact } from "@/components/created-by-cell";
import { DetailFacts } from "@/components/detail-facts";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
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
  const [activeSection, setActiveSection] = useState<"general" | "permissions">(
    "general",
  );

  const form = useForm<EditKnowledgeBaseFormValues>({
    defaultValues: {
      name: knowledgeBase.name,
      description: knowledgeBase.description ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      setActiveSection("general");
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
    <TabbedDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Knowledge Base"
      description="Update the knowledge base settings."
      sidebarLabel={form.watch("name") || "Knowledge base"}
      sidebarDescription="Knowledge base"
      sidebarIcon={<Database className="h-4 w-4 text-muted-foreground" />}
      activeSection={activeSection}
      navItems={[
        { id: "general", label: "General" },
        { id: "permissions", label: "Permissions" },
      ]}
      onActiveSectionChange={setActiveSection}
      onSubmit={form.handleSubmit(handleSubmit)}
      wrapForm={(content) => <Form {...form}>{content}</Form>}
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
      <div hidden={activeSection !== "general"} className="space-y-4">
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

        <AdvancedLabelsSection
          ref={labelsRef}
          labels={labels}
          onLabelsChange={setLabels}
        />
      </div>
      <div hidden={activeSection !== "permissions"}>
        <ResourceAccessSection
          resource="knowledgeBase"
          id={knowledgeBase.id}
          standalone
        />
      </div>
    </TabbedDialogShell>
  );
}
