"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { useCreateKnowledgeBase } from "@/lib/knowledge-base.query";
import {
  type KnowledgeBaseVisibility,
  VisibilitySelector,
} from "./visibility-selector";

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
  const [visibility, setVisibility] =
    useState<KnowledgeBaseVisibility>("org-wide");
  const [teamIds, setTeamIds] = useState<string[]>([]);

  const form = useForm<CreateKnowledgeBaseFormValues>({
    defaultValues: {
      name: "",
      description: "",
    },
  });

  const handleSubmit = async (values: CreateKnowledgeBaseFormValues) => {
    const result = await createKnowledgeBase.mutateAsync({
      name: values.name,
      ...(values.description && { description: values.description }),
      visibility,
      teamIds: visibility === "team-scoped" ? teamIds : [],
    });
    if (result) {
      form.reset();
      setVisibility("org-wide");
      setTeamIds([]);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Knowledge Base</DialogTitle>
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

            <VisibilitySelector
              visibility={visibility}
              onVisibilityChange={setVisibility}
              teamIds={teamIds}
              onTeamIdsChange={setTeamIds}
            />

            <DialogFooter>
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
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
