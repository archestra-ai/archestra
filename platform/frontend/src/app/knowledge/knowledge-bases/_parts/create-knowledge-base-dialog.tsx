// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { Database } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
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
import { useCreateKnowledgeBase } from "@/lib/knowledge/knowledge-base.query";
import {
  KnowledgeBaseAccessFields,
  type KnowledgeBaseFormValues,
} from "./knowledge-base-access-fields";

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
  const [activeSection, setActiveSection] = useState<"general" | "permissions">(
    "general",
  );

  useEffect(() => {
    if (open) setActiveSection("general");
  }, [open]);

  const form = useForm<KnowledgeBaseFormValues>({
    defaultValues: {
      name: "",
      description: "",
      initialGrants: [],
    },
  });

  const handleSubmit = async (values: KnowledgeBaseFormValues) => {
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
    const result = await createKnowledgeBase.mutateAsync({
      name: values.name,
      ...(values.description && { description: values.description }),
      labels: finalLabels,
      initialGrants: values.initialGrants.map(({ subject, actions }) => ({
        subject,
        actions,
      })),
    });
    if (result) {
      form.reset();
      setLabels([]);
      onOpenChange(false);
    }
  };

  return (
    <TabbedDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Create Knowledge Base"
      description="Create a searchable collection of content."
      sidebarLabel={form.watch("name") || "New knowledge base"}
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
          <Button type="submit" disabled={createKnowledgeBase.isPending}>
            {createKnowledgeBase.isPending
              ? "Creating..."
              : "Create Knowledge Base"}
          </Button>
        </>
      }
    >
      <div hidden={activeSection !== "general"} className="space-y-4">
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
        <KnowledgeBaseAccessFields form={form} standalone />
      </div>
    </TabbedDialogShell>
  );
}
