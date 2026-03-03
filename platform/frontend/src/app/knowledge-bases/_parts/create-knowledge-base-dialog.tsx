"use client";

import type { archestraApiTypes } from "@shared";
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateKnowledgeBase } from "@/lib/knowledge-base.query";

interface CreateKnowledgeBaseFormValues {
  name: string;
  provider: archestraApiTypes.CreateKnowledgeBaseData["body"]["provider"];
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

  const form = useForm<CreateKnowledgeBaseFormValues>({
    defaultValues: {
      name: "",
      provider: "lightrag",
      apiUrl: "",
      apiKey: "",
    },
  });

  const handleSubmit = async (values: CreateKnowledgeBaseFormValues) => {
    const result = await createKnowledgeBase.mutateAsync({
      name: values.name,
      provider: values.provider,
      config: {
        apiUrl: values.apiUrl,
        ...(values.apiKey ? { apiKey: values.apiKey } : {}),
      },
    });
    if (result) {
      form.reset();
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Knowledge Base</DialogTitle>
          <DialogDescription>
            Connect to a knowledge base provider to enable RAG-based document
            retrieval.
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
              name="provider"
              rules={{ required: "Provider is required" }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Provider</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a provider" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="lightrag">LightRAG</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

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
                    <Input type="password" placeholder="sk-..." {...field} />
                  </FormControl>
                  <FormDescription>
                    Optional API key for authentication.
                  </FormDescription>
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
