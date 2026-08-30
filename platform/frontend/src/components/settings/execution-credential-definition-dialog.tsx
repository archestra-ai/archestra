"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { AgentIconPicker } from "@/components/agent-icon-picker";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import {
  type ExecutionCredentialDefinition,
  useCreateExecutionCredential,
  useUpdateExecutionCredential,
} from "@/lib/execution-credentials.query";

export function ExecutionCredentialDefinitionDialog({
  definition,
  onClose,
}: {
  definition: ExecutionCredentialDefinition | null;
  onClose: () => void;
}) {
  const create = useCreateExecutionCredential();
  const update = useUpdateExecutionCredential();
  const form = useForm<DefinitionFormValues>({
    resolver: zodResolver(DefinitionFormSchema),
    defaultValues: {
      name: definition?.name ?? "",
      description: definition?.description ?? "",
      icon: definition?.icon ?? null,
      scope: definition?.allowOrganization ? "organization" : "personal",
    },
  });
  const pending = create.isPending || update.isPending;

  const save = (values: DefinitionFormValues) => {
    if (definition) {
      update.mutate(
        {
          key: definition.key,
          name: definition.name,
          body: {
            description: values.description.trim(),
            icon: values.icon,
          },
        },
        { onSuccess: onClose },
      );
      return;
    }

    create.mutate(
      {
        key: slugifyCredentialKey(values.name),
        name: values.name.trim(),
        description: values.description.trim(),
        icon: values.icon,
        allowPersonal: values.scope === "personal",
        allowOrganization: values.scope === "organization",
      },
      { onSuccess: onClose },
    );
  };

  return (
    <StandardFormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={definition ? `Edit ${definition.name}` : "Add credential"}
      description="Define a reusable secret that Agents can request at execution time."
      size="small"
      onSubmit={form.handleSubmit(save)}
      bodyClassName="space-y-4"
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : definition ? "Save changes" : "Add"}
          </Button>
        </>
      }
    >
      <Form {...form}>
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <div className="flex items-center gap-3">
                <FormField
                  control={form.control}
                  name="icon"
                  render={({ field: iconField }) => (
                    <AgentIconPicker
                      value={iconField.value}
                      onChange={iconField.onChange}
                      showLogos
                      className="size-9 rounded-md"
                    />
                  )}
                />
                <FormControl>
                  <Input
                    {...field}
                    autoFocus={!definition}
                    placeholder="GitLab access token"
                    disabled={Boolean(definition)}
                  />
                </FormControl>
              </div>
              <FormDescription>
                {definition
                  ? "The name is fixed because Agents may already reference this credential."
                  : "Use the name people will recognize when connecting the credential."}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  placeholder="Repository access for delegated coding tasks"
                  rows={2}
                />
              </FormControl>
              <FormDescription>
                Tell people what access the credential needs.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {!definition && (
          <FormField
            control={form.control}
            name="scope"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Provided by</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent position="popper">
                    <SelectItem
                      value="personal"
                      description="Each person connects a private value for executions they start."
                    >
                      Each user
                    </SelectItem>
                    <SelectItem
                      value="organization"
                      description="Admins connect one value used by everyone in the organization."
                    >
                      The organization
                    </SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
      </Form>
    </StandardFormDialog>
  );
}

const DefinitionFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(128)
    .regex(/[a-z0-9]/i, "Name must include a letter or number"),
  description: z.string().max(500),
  icon: z.string().nullable(),
  scope: z.enum(["personal", "organization"]),
});

type DefinitionFormValues = z.infer<typeof DefinitionFormSchema>;

function slugifyCredentialKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
}
