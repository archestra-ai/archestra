"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type { AgentTemplate } from "@shared";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { McpInstallDialogs } from "@/components/chat/mcp-install-dialogs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
  type TemplateRequirements,
  useAgentTemplateRequirements,
} from "@/lib/agent-templates.query";
import { useTemplateExecution } from "@/lib/use-template-execution";

const formSchema = z.record(z.string(), z.string());

type CreateFlowFormValues = z.infer<typeof formSchema>;

interface AgentTemplateCreateFlowProps {
  open: boolean;
  template: AgentTemplate | null;
  onOpenChange: (open: boolean) => void;
}

export function AgentTemplateCreateFlow({
  open,
  template,
  onOpenChange,
}: AgentTemplateCreateFlowProps) {
  const { execute, orchestrator } = useTemplateExecution();
  const { data: requirements, isPending } = useAgentTemplateRequirements(
    template?.id ?? null,
    { enabled: open },
  );
  const safeRequirements = requirements ?? null;
  const autoExecutedRef = useRef(false);

  const promptedFields = useMemo(
    () => collectPromptedFields(safeRequirements),
    [safeRequirements],
  );
  const unavailableTools = safeRequirements?.unavailableTools ?? [];
  const totalToolCount =
    safeRequirements?.toolAssignments.length ?? template?.tools.length ?? 0;
  const needsUserInput = promptedFields.length > 0;

  const form = useForm<CreateFlowFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: Object.fromEntries(
      promptedFields.map((field) => [field.formKey, ""]),
    ),
  });

  useEffect(() => {
    form.reset(
      Object.fromEntries(promptedFields.map((field) => [field.formKey, ""])),
    );
  }, [form, promptedFields]);
  const missingRequiredValues = promptedFields.some(
    (field) => field.field.required && !form.watch(field.formKey)?.trim(),
  );

  const handleExecute = useCallback(
    async (formValues: Record<string, string>) => {
      if (!safeRequirements) {
        return;
      }
      await execute({
        requirements: safeRequirements,
        formValues,
        onOpenChange,
      });
    },
    [safeRequirements, execute, onOpenChange],
  );

  useEffect(() => {
    if (
      !isPending &&
      safeRequirements &&
      !needsUserInput &&
      !autoExecutedRef.current
    ) {
      autoExecutedRef.current = true;
      void handleExecute({});
    }
  }, [isPending, safeRequirements, needsUserInput, handleExecute]);

  useEffect(() => {
    if (template) {
      autoExecutedRef.current = false;
    }
  }, [template]);

  if (!template) {
    return null;
  }

  if (isPending) {
    return (
      <>
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Creating {template.name}</DialogTitle>
              <DialogDescription>
                Setting up your agent and assigning tools...
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span>Preparing agent...</span>
            </div>
          </DialogContent>
        </Dialog>
        <McpInstallDialogs orchestrator={orchestrator} />
      </>
    );
  }

  if (!needsUserInput && safeRequirements) {
    return (
      <>
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Creating {template.name}</DialogTitle>
              <DialogDescription>
                Setting up your agent and assigning tools...
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span>Creating agent...</span>
            </div>
          </DialogContent>
        </Dialog>
        <McpInstallDialogs orchestrator={orchestrator} />
      </>
    );
  }

  const handleSubmit = form.handleSubmit(async () => {
    await handleExecute(form.getValues());
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create {template.name}</DialogTitle>
            <DialogDescription>{template.description}</DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form className="space-y-4 px-4 pt-4" onSubmit={handleSubmit}>
              <div className="grid grid-cols-2 gap-3 rounded-xl border bg-muted/30 p-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-background p-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  </div>
                  <div>
                    <p className="font-medium text-sm">Agent profile</p>
                    <p className="text-muted-foreground text-xs">
                      Prompt, labels, and name ready
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-background p-2">
                    <Wrench className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <p className="font-medium text-sm">
                      {totalToolCount} tool{totalToolCount !== 1 ? "s" : ""}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      Assigned after creation
                    </p>
                  </div>
                </div>
                {unavailableTools.length > 0 && (
                  <div className="col-span-2 flex items-center gap-3">
                    <div className="rounded-lg bg-background p-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                    </div>
                    <div>
                      <p className="font-medium text-sm">
                        {unavailableTools.length} unavailable
                      </p>
                      <p className="text-muted-foreground text-xs">
                        Skipped safely
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {unavailableTools.length > 0 && (
                <Alert className="border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    <p className="font-medium">Some tools are unavailable</p>
                    <p className="mt-1 text-xs">
                      Agent will still be created. Missing catalogs can be
                      installed later from MCPs.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {unavailableTools.map((tool) => (
                        <Badge key={tool.toolName} variant="outline">
                          {tool.toolName}
                        </Badge>
                      ))}
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              {promptedFields.map((field) => (
                <FormField
                  key={field.formKey}
                  control={form.control}
                  name={field.formKey}
                  render={({ field: formField }) => (
                    <FormItem>
                      <FormLabel>{field.title}</FormLabel>
                      <FormControl>
                        <Input
                          {...formField}
                          value={formField.value ?? ""}
                          type={
                            field.source === "userConfig" &&
                            "sensitive" in field.field &&
                            field.field.sensitive
                              ? "password"
                              : "text"
                          }
                        />
                      </FormControl>
                      {field.field.description && (
                        <FormDescription>
                          {renderDescription(field.field.description)}
                        </FormDescription>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ))}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={form.formState.isSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    form.formState.isSubmitting || missingRequiredValues
                  }
                >
                  {form.formState.isSubmitting ? "Creating..." : "Create Agent"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <McpInstallDialogs orchestrator={orchestrator} />
    </>
  );
}

function renderDescription(description: string) {
  const urlPattern = /(https?:\/\/[^\s)]+)/g;
  const parts = description.split(urlPattern);
  if (parts.length <= 1) {
    return description;
  }

  const elements: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (urlPattern.test(part)) {
      urlPattern.lastIndex = 0;
      elements.push(
        <a
          key={`link-${i}`}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2 inline-flex items-center gap-0.5"
        >
          {part}
          <ExternalLink className="h-3 w-3" />
        </a>,
      );
    } else {
      elements.push(<span key={`txt-${i}`}>{part}</span>);
    }
  }

  return <>{elements}</>;
}

type PromptedField = {
  source: "userConfig" | "environment";
  formKey: string;
  catalogId: string;
  key: string;
  title: string;
  field:
    | TemplateRequirements["missingCatalogs"][number]["userConfigFields"][number]
    | TemplateRequirements["missingCatalogs"][number]["environmentFields"][number];
};

function collectPromptedFields(
  requirements: TemplateRequirements | null,
): PromptedField[] {
  return (
    requirements?.missingCatalogs
      .filter((catalog) => !catalog.canAutoInstall)
      .flatMap((catalog) => [
        ...catalog.userConfigFields.map((field) => ({
          source: "userConfig" as const,
          formKey: buildFormKey(catalog.catalogId, "userConfig", field.key),
          catalogId: catalog.catalogId,
          key: field.key,
          title: field.title,
          field,
        })),
        ...catalog.environmentFields.map((field) => ({
          source: "environment" as const,
          formKey: buildFormKey(catalog.catalogId, "environment", field.key),
          catalogId: catalog.catalogId,
          key: field.key,
          title: field.key,
          field,
        })),
      ]) ?? []
  );
}

function buildFormKey(
  catalogId: string,
  source: "userConfig" | "environment",
  key: string,
) {
  return `${catalogId}::${source}::${key}`;
}
