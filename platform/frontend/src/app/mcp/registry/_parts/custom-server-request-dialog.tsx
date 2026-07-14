"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { EnvironmentVariableSchema } from "@archestra/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";
import { EnvironmentVariablesFormField } from "@/components/environment-variables-form-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogForm,
  DialogHeader,
  DialogStickyFooter,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCreateMcpServerInstallationRequest } from "@/lib/mcp/mcp-server-installation-request.query";
import { parseMcpServerConfigJson } from "./mcp-config-parser";

const customServerRequestSchema = z
  .object({
    serverType: z.enum(["remote", "local"]),
    label: z.string().min(1, "Display name is required"),
    name: z.string().min(1, "Technical name is required"),
    version: z.string().optional(),
    serverUrl: z.string().optional(),
    docsUrl: z.string().optional(),
    command: z.string().optional(),
    arguments: z.string(),
    environment: z.array(EnvironmentVariableSchema),
    requestReason: z.string(),
  })
  .refine(
    (data) => {
      if (data.serverType === "local") {
        return data.command && data.command.trim().length > 0;
      }
      return true;
    },
    {
      message: "Command is required for local servers",
      path: ["command"],
    },
  );

type CustomServerRequestFormValues = z.infer<typeof customServerRequestSchema>;

export function CustomServerRequestDialog({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const form = useForm<CustomServerRequestFormValues>({
    // biome-ignore lint/suspicious/noExplicitAny: Version mismatch between @hookform/resolvers and Zod
    resolver: zodResolver(customServerRequestSchema as any),
    defaultValues: {
      serverType: "remote",
      label: "",
      name: "",
      version: "",
      serverUrl: "",
      docsUrl: "",
      command: "",
      arguments: "",
      environment: [],
      requestReason: "",
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "environment",
  });

  /**
   * Handles paste events on the Arguments textarea. If the pasted text is a
   * recognised MCP server config, auto-fills command, arguments, and env vars.
   * Otherwise, lets the browser paste normally.
   */
  const handleConfigPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedText = e.clipboardData.getData("text");
    const parsed = parseMcpServerConfigJson(pastedText);
    if (!parsed) return;

    e.preventDefault();

    // Remote server — switch type and fill URL
    if (parsed.serverType === "remote" && parsed.serverUrl) {
      form.setValue("serverType", "remote", { shouldDirty: true });
      form.setValue("serverUrl", parsed.serverUrl, { shouldDirty: true });
      return;
    }

    // Local server — fill command, arguments, env
    if (parsed.command) {
      form.setValue("command", parsed.command, { shouldDirty: true });
    }

    if (parsed.arguments !== undefined) {
      form.setValue("arguments", parsed.arguments, { shouldDirty: true });
    }

    if (parsed.environment && parsed.environment.length > 0) {
      form.setValue(
        "environment",
        parsed.environment.map((env) => ({
          key: env.key,
          type: env.type,
          value: env.value,
          promptOnInstallation: env.promptOnInstallation,
          required: env.required ?? false,
          description: env.description ?? "",
        })),
        { shouldDirty: true },
      );
    }
  };

  const createRequest = useCreateMcpServerInstallationRequest();

  const onSubmit = async (values: CustomServerRequestFormValues) => {
    const customServerConfig: NonNullable<
      archestraApiTypes.CreateMcpServerInstallationRequestData["body"]["customServerConfig"]
    > =
      values.serverType === "remote"
        ? {
            type: "remote" as const,
            label: values.label,
            name: values.name,
            version: values.version || undefined,
            serverType: "remote" as const,
            serverUrl: values.serverUrl || undefined,
            docsUrl: values.docsUrl || undefined,
            userConfig: undefined,
            oauthConfig: undefined,
          }
        : {
            type: "local" as const,
            label: values.label,
            name: values.name,
            version: values.version || undefined,
            serverType: "local" as const,
            localConfig: {
              command: values.command,
              arguments: values.arguments
                .split("\n")
                .map((arg) => arg.trim())
                .filter((arg) => arg.length > 0),
              environment:
                values.environment.length > 0 ? values.environment : undefined,
            },
          };

    await createRequest.mutateAsync({
      externalCatalogId: null,
      requestReason: values.requestReason,
      customServerConfig,
    });

    form.reset();
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[800px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Request Custom MCP Server Installation</DialogTitle>
          <DialogDescription>
            Request a custom MCP server to be added to your organization's
            internal registry. An admin will review your request.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <DialogForm onSubmit={form.handleSubmit(onSubmit)}>
            <div className="space-y-4 py-4">
              <FormField
                control={form.control}
                name="serverType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Server Type *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select server type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="remote">Remote</SelectItem>
                        <SelectItem value="local">Local</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="label"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Display Name *</FormLabel>
                      <FormControl>
                        <Input placeholder="My Custom MCP Server" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Technical Name *</FormLabel>
                      <FormControl>
                        <Input placeholder="my-custom-server" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="version"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Version</FormLabel>
                      <FormControl>
                        <Input placeholder="1.0.0" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {form.watch("serverType") === "remote" && (
                <>
                  <FormField
                    control={form.control}
                    name="serverUrl"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Server URL</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="https://example.com/mcp"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="docsUrl"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Documentation URL</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="https://example.com/docs"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}

              {form.watch("serverType") === "local" && (
                <>
                  <FormField
                    control={form.control}
                    name="command"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Command *</FormLabel>
                        <FormControl>
                          <Input placeholder="node" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="arguments"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Arguments (one per line or paste JSON config)
                        </FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder={`/path/to/server.js\n--verbose\n\n—or paste a full MCP server JSON config`}
                            rows={3}
                            onPaste={handleConfigPaste}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <EnvironmentVariablesFormField
                    fields={fields}
                    append={append}
                    remove={remove}
                    fieldNamePrefix="environment"
                    form={form}
                  />
                </>
              )}

              <FormField
                control={form.control}
                name="requestReason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Reason for Request{" "}
                      <span className="text-muted-foreground">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Explain why your team needs this custom MCP server..."
                        rows={3}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogStickyFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={createRequest.isPending}>
                {createRequest.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                Submit Request
              </Button>
            </DialogStickyFooter>
          </DialogForm>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
