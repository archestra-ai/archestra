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

  const createRequest = useCreateMcpServerInstallationRequest();

  const handleArgumentsChange = (value: string) => {
    const parsed = parseMcpConfig(value);
    if (parsed) {
      if (parsed.serverType) {
        form.setValue("serverType", parsed.serverType, { shouldDirty: true });
      }
      if (parsed.name) {
        form.setValue("name", parsed.name, { shouldDirty: true });
        if (!form.getValues("label")) {
          const formattedLabel = parsed.name
            .split(/[-_]+/)
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ");
          form.setValue("label", formattedLabel, { shouldDirty: true });
        }
      }
      if (parsed.docsUrl) {
        form.setValue("docsUrl", parsed.docsUrl, { shouldDirty: true });
      }
      if (parsed.serverType === "remote") {
        if (parsed.serverUrl) {
          form.setValue("serverUrl", parsed.serverUrl, { shouldDirty: true });
        }
      } else {
        if (parsed.command) {
          form.setValue("command", parsed.command, { shouldDirty: true });
        }
        if (parsed.arguments !== undefined) {
          form.setValue("arguments", parsed.arguments, { shouldDirty: true });
        }
        if (parsed.environment && parsed.environment.length > 0) {
          form.setValue("environment", parsed.environment, { shouldDirty: true });
        }
      }
    }
  };

  const onSubmit = async (values: CustomServerRequestFormValues) =>. {
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
                        <FormLabel>Arguments (one per line)</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder={`/path/to/server.js\n--verbose`}
                            rows={3}
                            {...field}
                            onChange={(e) => {
                              field.onChange(e);
                              handleArgumentsChange(e.target.value);
                            }}
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

function parseMcpConfig(jsonStr: string) {
  let json: any;
  try {
    const trimmed = jsonStr.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return null;
    }
    json = JSON.parse(trimmed);
  } catch (e) {
    return null;
  }

  let config: any = null;
  let name = "";
  let description = "";
  let docsUrl = "";

  const isServerConfig = (obj: any) => {
    return (
      obj &&
      typeof obj === "object" &&
      ("command" in obj ||
        "url" in obj ||
        "serverUrl" in obj ||
        "args" in obj ||
        "arguments" in obj ||
        "env" in obj ||
        "environment" in obj)
    );
  };

  if (json.mcpServers && typeof json.mcpServers === "object") {
    const keys = Object.keys(json.mcpServers);
    if (keys.length > 0) {
      name = keys[0];
      config = json.mcpServers[name];
    }
  } else if (json.servers && typeof json.servers === "object") {
    const keys = Object.keys(json.servers);
    if (keys.length > 0) {
      name = keys[0];
      config = json.servers[name];
    }
  } else if (json.server && typeof json.server === "object") {
    config = json.server;
    if (json.name) name = json.name;
    if (json.description) description = json.description;
    if (json.docsUrl) docsUrl = json.docsUrl;
    if (json.docs_url) docsUrl = json.docs_url;
  } else if (
    Object.keys(json).length === 1 &&
    isServerConfig(json[Object.keys(json)[0]])
  ) {
    name = Object.keys(json)[0];
    config = json[name];
  } else if (isServerConfig(json)) {
    config = json;
    if (json.name) name = json.name;
    if (json.description) description = json.description;
  }

  if (!config) {
    return null;
  }

  if (!docsUrl) {
    docsUrl = config.docsUrl || config.docs_url || "";
  }

  let serverType: "remote" | "local" = "local";
  if (
    config.type === "remote" ||
    config.type === "http" ||
    config.type === "sse" ||
    config.url ||
    config.serverUrl
  ) {
    serverType = "remote";
  } else if (
    config.type === "local" ||
    config.type === "stdio" ||
    config.command
  ) {
    serverType = "local";
  }

  const command = config.command || "";

  let argsArray: string[] = [];
  if (Array.isArray(config.args)) {
    argsArray = config.args;
  } else if (Array.isArray(config.arguments)) {
    argsArray = config.arguments;
  }
  const argsStr = argsArray.map((arg) => String(arg)).join("\n");

  const serverUrl = config.url || config.serverUrl || "";

  const envObj = config.env || config.environment || {};
  const environment: any[] = [];
  if (typeof envObj === "object" && envObj !== null) {
    for (const [key, val] of Object.entries(envObj)) {
      const valStr = String(val);
      const isPlaceholder = (v: string) => {
        const lower = v.toLowerCase().trim();
        return (
          lower === "" ||
          lower.includes("your_token_here") ||
          lower.includes("your_key_here") ||
          lower.includes("enter_token") ||
          lower.includes("enter_key") ||
          lower.includes("<token>") ||
          lower.includes("<key>") ||
          lower.includes("<org>") ||
          lower.includes("<username>") ||
          lower.includes("<password>") ||
          lower.includes("redacted") ||
          lower.includes("todo") ||
          lower.startsWith("${input:") ||
          (v.startsWith("<") && v.endsWith(">")) ||
          (v.startsWith("[") && v.endsWith("]"))
        );
      };

      const isSecret = (k: string) => {
        const lower = k.toLowerCase();
        return (
          lower.includes("token") ||
          lower.includes("key") ||
          lower.includes("secret") ||
          lower.includes("pass") ||
          lower.includes("auth") ||
          lower.includes("jwt") ||
          lower.includes("cert") ||
          lower.includes("private") ||
          lower.includes("cred")
        );
      };

      const placeholder = isPlaceholder(valStr);
      environment.push({
        key,
        type: isSecret(key) ? "secret" : "plain_text",
        value: placeholder ? "" : valStr,
        promptOnInstallation: placeholder,
        required: placeholder,
      });
    }
  }

  const headersObj = config.headers || {};
  const headers: any[] = [];
  if (typeof headersObj === "object" && headersObj !== null) {
    for (const [key, val] of Object.entries(headersObj)) {
      const valStr = String(val);
      const isPlaceholder = (v: string) => {
        const lower = v.toLowerCase().trim();
        return (
          lower === "" ||
          lower.includes("your_token_here") ||
          lower.includes("your_key_here") ||
          lower.includes("<token>") ||
          lower.includes("<key>") ||
          lower.includes("redacted") ||
          lower.startsWith("${input:") ||
          (v.startsWith("<") && v.endsWith(">"))
        );
      };

      const isSecret = (k: string) => {
        const lower = k.toLowerCase();
        return (
          lower.includes("token") ||
          lower.includes("key") ||
          lower.includes("secret") ||
          lower.includes("pass") ||
          lower.includes("auth") ||
          lower.includes("jwt") ||
          lower.includes("authorization")
        );
      };

      const placeholder = isPlaceholder(valStr);
      headers.push({
        fieldName: undefined,
        headerName: key,
        promptOnInstallation: placeholder,
        required: placeholder,
        value: placeholder ? "" : valStr,
        description: "",
        includeBearerPrefix: valStr.toLowerCase().includes("bearer"),
        sensitive: isSecret(key),
      });
    }
  }

  return {
    name,
    description,
    serverType,
    command,
    arguments: argsStr,
    serverUrl,
    docsUrl,
    environment,
    headers,
  };
}
