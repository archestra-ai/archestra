"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useCreateKnowledgeBase } from "@/lib/knowledge-base.query";
import { VisibilitySelector } from "./visibility-selector";

interface CreateKnowledgeBaseFormValues {
  name: string;
  description: string;
  apiUrl: string;
  apiKey: string;
}

export function CreateKnowledgeBaseDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createKnowledgeBase = useCreateKnowledgeBase();
  const [visibility, setVisibility] = useState<
    "org-wide" | "team-scoped" | "auto-sync-permissions"
  >("org-wide");
  const [teamIds, setTeamIds] = useState<string[]>([]);

  const form = useForm<CreateKnowledgeBaseFormValues>({
    defaultValues: {
      name: "",
      description: "",
      apiUrl: "",
      apiKey: "",
    },
  });

  const handleSubmit = async (values: CreateKnowledgeBaseFormValues) => {
    const result = await createKnowledgeBase.mutateAsync({
      name: values.name,
      ...(values.description && { description: values.description }),
      provider: "lightrag",
      visibility,
      teamIds: visibility === "team-scoped" ? teamIds : [],
      config: {
        apiUrl: values.apiUrl,
        ...(values.apiKey ? { apiKey: values.apiKey } : {}),
      },
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

            <Collapsible>
              <CollapsibleTrigger className="flex w-full items-center justify-between cursor-pointer group rounded-lg border p-3">
                <span className="text-sm font-medium">Advanced</span>
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-4 space-y-4">
                <FormField
                  control={form.control}
                  name="apiUrl"
                  rules={{ required: "API URL is required" }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>API URL</FormLabel>
                      <FormControl>
                        <Input placeholder="http://localhost:9621" {...field} />
                      </FormControl>
                      <FormDescription>
                        The URL of the knowledge base API server.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="apiKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>API Key (optional)</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder="sk-..."
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Optional API key for authentication.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CollapsibleContent>
            </Collapsible>

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
