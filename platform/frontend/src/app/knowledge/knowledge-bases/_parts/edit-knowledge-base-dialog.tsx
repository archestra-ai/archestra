"use client";

import type { archestraApiTypes } from "@shared";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
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
import { useUpdateKnowledgeBase } from "@/lib/knowledge-base.query";
import {
  type KnowledgeBaseVisibility,
  VisibilitySelector,
} from "./visibility-selector";

type KnowledgeBaseItem =
  archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"][number];

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
  const [visibility, setVisibility] = useState<KnowledgeBaseVisibility>(
    knowledgeBase.visibility,
  );
  const [teamIds, setTeamIds] = useState<string[]>(knowledgeBase.teamIds);

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
      setVisibility(knowledgeBase.visibility);
      setTeamIds(knowledgeBase.teamIds);
    }
  }, [open, knowledgeBase, form]);

  const handleSubmit = async (values: EditKnowledgeBaseFormValues) => {
    const result = await updateKnowledgeBase.mutateAsync({
      id: knowledgeBase.id,
      body: {
        name: values.name,
        description: values.description || null,
        visibility,
        teamIds: visibility === "team-scoped" ? teamIds : [],
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

            <VisibilitySelector
              visibility={visibility}
              onVisibilityChange={setVisibility}
              teamIds={teamIds}
              onTeamIdsChange={setTeamIds}
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
