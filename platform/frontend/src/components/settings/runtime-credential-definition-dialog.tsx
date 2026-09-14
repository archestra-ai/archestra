"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { AgentIconPicker } from "@/components/agent-icon-picker";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
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
  type RuntimeCredentialDefinition,
  useCreateRuntimeCredential,
  useUpdateRuntimeCredential,
} from "@/lib/runtime-credentials.query";

export function RuntimeCredentialDefinitionDialog({
  definition,
  onClose,
}: {
  definition: RuntimeCredentialDefinition | null;
  onClose: () => void;
}) {
  const create = useCreateRuntimeCredential();
  const update = useUpdateRuntimeCredential();
  const form = useForm<DefinitionFormValues>({
    resolver: zodResolver(DefinitionFormSchema),
    defaultValues: {
      name: definition?.name ?? "",
      kind: definition?.kind ?? "secret",
      githubUrl: definition?.githubUrl ?? "https://api.github.com",
      appId: definition?.appId ?? "",
      installationId: definition?.installationId ?? "",
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
            name: values.name.trim(),
            githubUrl: values.kind === "github_app" ? values.githubUrl : null,
            appId: values.kind === "github_app" ? values.appId : null,
            installationId:
              values.kind === "github_app" ? values.installationId : null,
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
        kind: values.kind,
        githubUrl: values.kind === "github_app" ? values.githubUrl : null,
        appId: values.kind === "github_app" ? values.appId : null,
        installationId:
          values.kind === "github_app" ? values.installationId : null,
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
      description="Choose the credential type and who provides its value. Use it across the platform."
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
              <FormDescription>
                Use a name people will recognize when selecting this credential.
              </FormDescription>
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
                  />
                </FormControl>
              </div>
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
              <FormDescription>
                Tell people what access the credential needs.
              </FormDescription>
              <FormControl>
                <Textarea
                  {...field}
                  placeholder="Repository access for delegated coding tasks"
                  rows={2}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="kind"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Credential type</FormLabel>
              <Select
                value={field.value}
                onValueChange={(value) => {
                  field.onChange(value);
                  if (value === "github_app")
                    form.setValue("scope", "organization", {
                      shouldDirty: true,
                    });
                }}
                disabled={Boolean(definition)}
              >
                <FormControl>
                  <SelectTrigger className="w-full">
                    <span className="flex items-center gap-2">
                      {field.value && (
                        <RuntimeCredentialIcon
                          icon={
                            field.value === "github_app" ? "logo:github" : null
                          }
                          className="size-4 text-muted-foreground"
                        />
                      )}
                      <SelectValue placeholder="Select credential type" />
                    </span>
                  </SelectTrigger>
                </FormControl>
                <SelectContent position="popper">
                  <SelectItem
                    value="secret"
                    icon={
                      <RuntimeCredentialIcon icon={null} className="size-4" />
                    }
                  >
                    Custom secret
                  </SelectItem>
                  <SelectItem
                    value="github_app"
                    icon={
                      <RuntimeCredentialIcon
                        icon="logo:github"
                        className="size-4"
                      />
                    }
                  >
                    GitHub App
                  </SelectItem>
                </SelectContent>
              </Select>
              {field.value === "github_app" && (
                <FormDescription>
                  Add the app details below, then connect its private key after
                  saving. Integrations use an installation token; the private
                  key stays in the secrets manager.
                </FormDescription>
              )}
              <FormMessage />
            </FormItem>
          )}
        />
        {form.watch("kind") === "github_app" && (
          <div className="space-y-4">
            {(["githubUrl", "appId", "installationId"] as const).map((name) => (
              <FormField
                key={name}
                control={form.control}
                name={name}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {name === "githubUrl"
                        ? "GitHub API URL"
                        : name === "appId"
                          ? "App ID"
                          : "Installation ID"}
                    </FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
          </div>
        )}
        {!definition && (
          <FormField
            control={form.control}
            name="scope"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Provided by</FormLabel>
                {form.watch("kind") === "github_app" && (
                  <FormDescription>
                    GitHub Apps use an organization-managed installation and
                    private key.
                  </FormDescription>
                )}
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={form.watch("kind") === "github_app"}
                >
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent position="popper">
                    <SelectItem
                      value="personal"
                      description="Each person connects a private value for runs they start."
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

const DefinitionFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Name is required")
      .max(128)
      .regex(/[a-z0-9]/i, "Name must include a letter or number"),
    description: z.string().max(500),
    icon: z.string().nullable(),
    scope: z.enum(["personal", "organization"]),
    kind: z.enum(["secret", "github_app"]),
    githubUrl: z.string(),
    appId: z.string(),
    installationId: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.kind !== "github_app") return;
    if (value.scope !== "organization")
      ctx.addIssue({
        code: "custom",
        path: ["scope"],
        message: "GitHub Apps are provided by the organization",
      });
    for (const field of ["appId", "installationId"] as const) {
      if (!value[field].trim())
        ctx.addIssue({ code: "custom", path: [field], message: "Required" });
    }
    if (!/^https?:\/\//.test(value.githubUrl))
      ctx.addIssue({
        code: "custom",
        path: ["githubUrl"],
        message: "Enter an HTTP(S) API URL",
      });
  });

type DefinitionFormValues = z.infer<typeof DefinitionFormSchema>;

function slugifyCredentialKey(value: string): string {
  return (
    "credential-" +
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  ).slice(0, 128);
}
