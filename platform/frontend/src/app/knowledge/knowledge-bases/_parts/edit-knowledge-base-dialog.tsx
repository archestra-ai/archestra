"use client";

import type { archestraApiTypes } from "@shared";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
    }
  }, [open, knowledgeBase, form]);

  const handleSubmit = async (values: EditKnowledgeBaseFormValues) => {
    const result = await updateKnowledgeBase.mutateAsync({
      id: knowledgeBase.id,
      body: {
        name: values.name,
        description: values.description || null,
      },
    });
    if (result) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Knowledge Base</DialogTitle>
          <DialogDescription>
            Update the knowledge base settings.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-4"
          >
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

            <DialogFooter>
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
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
