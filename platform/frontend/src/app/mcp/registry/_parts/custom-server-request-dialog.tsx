"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type { archestraApiTypes } from "@shared";
import { EnvironmentVariableSchema } from "@shared";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";

function parseArgumentsString(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (a: unknown) => typeof a === "string" && a.length > 0,
        );
      }
    } catch {
      // Fall through to line-by-line
    }
  }
  return trimmed
    .split("\n")
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);
}

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
  const [argumentsMode, setArgumentsMode] = useState<"line" | "json">("line");

  const switchArgumentsMode = (mode: "line" | "json") => {
    const currentValue = form.getValues("arguments") || "";
    if (mode === argumentsMode) return;

    if (mode === "json" && currentValue.trim()) {
      const lines = currentValue
        .split("\n")
        .map((arg: string) => arg.trim())
        .filter((arg: string) => arg.length > 0);
      form.setValue("arguments", JSON.stringify(lines, null, 2), {
        shouldDirty: true,
      });
    } else if (mode === "line" && currentValue.trim()) {
      try {
        const parsed = JSON.parse(currentValue);
        if (Array.isArray(parsed)) {
          form.setValue(
            "arguments",
            parsed.filter((a: unknown) => typeof a === "string").join("\n"),
            { shouldDirty: true },
          );
        }
      } catch {
        // If not valid JSON, keep as-is
      }
    }

    setArgumentsMode(mode);
  };

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
              arguments: parseArgumentsString(values.arguments),
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
                          <div className="flex items-center gap-2">
                            Arguments
                            <div className="flex rounded-md border">
                              <button
                                type="button"
                                className={`px-2 py-0.5 text-xs rounded-l-md ${argumentsMode === "line" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                                onClick={() => switchArgumentsMode("line")}
                              >
                                Line by line
                              </button>
                              <button
                                type="button"
                                className={`px-2 py-0.5 text-xs rounded-r-md ${argumentsMode === "json" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                                onClick={() => switchArgumentsMode("json")}
                              >
                                JSON
                              </button>
                            </div>
                          </div>
                        </FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder={
                              argumentsMode === "json"
                                ? `["--verbose", "--port", "3000"]`
                                : `/path/to/server.js\n--verbose`
                            }
                            rows={3}
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
