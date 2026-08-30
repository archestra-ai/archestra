"use client";

import { ArrowLeft, Loader2, Plus, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchableMultiSelect } from "@/components/searchable-multi-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { WizardFooter } from "@/components/wizard-footer";
import { WizardStepper } from "@/components/wizard-stepper";
import { useProfiles } from "@/lib/agent.query";
import {
  type Bundle,
  useBundle,
  useCreateBundle,
  useUpdateBundle,
} from "@/lib/bundle.query";
import { usePlugins } from "@/lib/plugins/plugin.query";
import { useAllSkills } from "@/lib/skills/skill.query";
import {
  BUNDLE_STEPS,
  type BundleStep,
  bundleDetailHref,
  resolveBundleStep,
} from "./bundle-page-config";

type BundleFormValues = {
  name: string;
  description: string;
  mcpGatewayId: string;
  skillIds: string[];
  pluginIds: string[];
  localMcpServers: Array<{
    id?: string;
    name: string;
    description: string;
    command: string;
    args: string;
    envVarNames: string;
    optional: boolean;
  }>;
};

const EMPTY_VALUES: BundleFormValues = {
  name: "",
  description: "",
  mcpGatewayId: "",
  skillIds: [],
  pluginIds: [],
  localMcpServers: [],
};

export function BundleCreatePage() {
  return <BundleEditor bundle={null} />;
}

export function BundleEditPage({ bundleId }: { bundleId: string }) {
  const { data, isPending, isLoadingError, refetch } = useBundle(bundleId);
  if (isPending) return <BundleEditorLoading title="Edit bundle" />;
  if (isLoadingError) {
    return (
      <PageLayout title="Edit bundle" maxWidth="wizard">
        <QueryLoadError title="Couldn't load this bundle" onRetry={refetch} />
      </PageLayout>
    );
  }
  if (!data) {
    return (
      <PageLayout title="Bundle not found" maxWidth="wizard">
        <p className="text-sm text-muted-foreground">
          This bundle no longer exists or is not accessible.
        </p>
      </PageLayout>
    );
  }
  return <BundleEditor bundle={data} />;
}

function BundleEditor({ bundle }: { bundle: Bundle | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const step = resolveBundleStep(searchParams.get("step"));
  const createBundle = useCreateBundle();
  const updateBundle = useUpdateBundle(bundle?.id ?? "");
  const { data: skills = [] } = useAllSkills();
  const { data: plugins = [] } = usePlugins();
  const { data: gateways = [] } = useProfiles({
    filters: { agentTypes: ["profile", "mcp_gateway"] },
  });
  const defaults = useMemo(
    () =>
      bundle
        ? {
            name: bundle.name,
            description: bundle.description,
            mcpGatewayId: bundle.mcpGatewayId ?? "",
            skillIds: bundle.skillIds,
            pluginIds: bundle.pluginIds,
            localMcpServers: bundle.localMcpServers.map((server) => ({
              ...server,
              args: server.args.join("\n"),
              envVarNames: server.envVarNames.join(", "),
            })),
          }
        : EMPTY_VALUES,
    [bundle],
  );
  const form = useForm<BundleFormValues>({ defaultValues: defaults });
  const localMcpServers = useFieldArray({
    control: form.control,
    name: "localMcpServers",
    keyName: "_key",
  });
  useEffect(() => form.reset(defaults), [defaults, form]);
  const isDirty = form.formState.isDirty;
  useBeforeUnloadWhileDirty(isDirty);
  const leave = useCallback(
    (open: boolean) => {
      if (!open) router.push(bundle ? bundleDetailHref(bundle.id) : "/bundles");
    },
    [bundle, router],
  );
  const guard = useUnsavedChangesGuard({ isDirty, onOpenChange: leave });
  const navigateStep = (next: BundleStep) => {
    const base = bundle
      ? `${bundleDetailHref(bundle.id)}/edit`
      : "/bundles/new";
    router.push(`${base}?step=${next}`, { scroll: false });
  };
  const pending = createBundle.isPending || updateBundle.isPending;
  const submit = form.handleSubmit(async (values) => {
    const body = {
      name: values.name.trim(),
      description: values.description.trim(),
      mcpGatewayId: values.mcpGatewayId || null,
      skillIds: values.skillIds,
      pluginIds: values.pluginIds,
      localMcpServers: values.localMcpServers.map((server) => ({
        ...(server.id ? { id: server.id } : {}),
        name: server.name.trim(),
        description: server.description.trim(),
        command: server.command.trim(),
        args: server.args
          .split("\n")
          .map((arg) => arg.trim())
          .filter(Boolean),
        envVarNames: server.envVarNames
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
        optional: server.optional,
      })),
    };
    const result = bundle
      ? await updateBundle.mutateAsync(body)
      : await createBundle.mutateAsync(body);
    if (result) router.push(bundleDetailHref(result.id));
  });

  return (
    <PageLayout
      title={bundle ? `Edit ${bundle.name}` : "Create bundle"}
      status={<Badge variant="secondary">Beta</Badge>}
      description="Define a reusable set of skills, plugins, and MCP gateway access."
      backLink={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 text-muted-foreground"
          onClick={guard.requestClose}
        >
          <ArrowLeft className="size-4" />
          <span>{bundle ? "Bundle" : "Bundles"}</span>
        </Button>
      }
      maxWidth="wizard"
    >
      <form
        onSubmit={submit}
        className="overflow-hidden rounded-lg border bg-card"
      >
        <div className="border-b px-6 py-5">
          <WizardStepper
            steps={BUNDLE_STEPS}
            activeStep={step}
            onStepClick={navigateStep}
          />
        </div>
        <div className="min-h-[360px] space-y-6 p-6">
          {step === "details" ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="bundle-name">Name</Label>
                <Input
                  id="bundle-name"
                  autoFocus
                  placeholder="Software engineer"
                  {...form.register("name", { required: true })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="bundle-description">Description</Label>
                <Textarea
                  id="bundle-description"
                  placeholder="What this bundle equips a connected client to do."
                  {...form.register("description")}
                />
              </div>
            </>
          ) : (
            <>
              <section
                aria-labelledby="bundle-standard-content"
                className="space-y-4"
              >
                <div>
                  <h2
                    id="bundle-standard-content"
                    className="text-sm font-semibold"
                  >
                    Standard content
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Skills are delivered together as one generated plugin.
                    Native plugins remain independently managed.
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label id="bundle-skills-label" htmlFor="bundle-skills">
                    Skills ({form.watch("skillIds").length} selected)
                  </Label>
                  <SearchableMultiSelect
                    id="bundle-skills"
                    aria-labelledby="bundle-skills-label"
                    value={form.watch("skillIds")}
                    onValueChange={(value) =>
                      form.setValue("skillIds", value, { shouldDirty: true })
                    }
                    items={skills.map((skill) => ({
                      value: skill.id,
                      label: skill.name,
                    }))}
                    placeholder="Select skills..."
                    searchPlaceholder="Search skills..."
                    emptyMessage="No skills available."
                  />
                </div>
                <div className="grid gap-2">
                  <Label id="bundle-plugins-label" htmlFor="bundle-plugins">
                    Plugins ({form.watch("pluginIds").length} selected)
                  </Label>
                  <SearchableMultiSelect
                    id="bundle-plugins"
                    aria-labelledby="bundle-plugins-label"
                    value={form.watch("pluginIds")}
                    onValueChange={(value) =>
                      form.setValue("pluginIds", value, { shouldDirty: true })
                    }
                    items={plugins.map((plugin) => ({
                      value: plugin.id,
                      label: plugin.displayName,
                      description: plugin.clientType,
                    }))}
                    placeholder="Select plugins..."
                    searchPlaceholder="Search plugins..."
                    emptyMessage="No approved plugins available."
                  />
                </div>
              </section>
              <section
                aria-labelledby="bundle-connection-configuration"
                className="space-y-4 border-t pt-6"
              >
                <div>
                  <h2
                    id="bundle-connection-configuration"
                    className="text-sm font-semibold"
                  >
                    Connection configuration
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Optionally set a gateway and local MCP servers for
                    compatible clients.
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="bundle-mcp-gateway">MCP gateway</Label>
                  <Select
                    value={form.watch("mcpGatewayId") || "current"}
                    onValueChange={(value) =>
                      form.setValue(
                        "mcpGatewayId",
                        value === "current" ? "" : value,
                        { shouldDirty: true },
                      )
                    }
                  >
                    <SelectTrigger id="bundle-mcp-gateway">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="current">
                        Keep current gateway
                      </SelectItem>
                      {gateways.map((gateway) => (
                        <SelectItem key={gateway.id} value={gateway.id}>
                          {gateway.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-medium">
                        Local MCP servers ({localMcpServers.fields.length})
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Package stdio configuration for Cursor and Claude Code.
                        Secrets are referenced by environment variable name and
                        are never stored here.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        localMcpServers.append({
                          name: "",
                          description: "",
                          command: "",
                          args: "",
                          envVarNames: "",
                          optional: true,
                        })
                      }
                    >
                      <Plus className="size-4" />
                      <span>Add server</span>
                    </Button>
                  </div>
                  {localMcpServers.fields.map((field, index) => (
                    <div
                      key={field._key}
                      className="grid gap-4 rounded-lg border bg-muted/20 p-4"
                    >
                      <input
                        type="hidden"
                        {...form.register(`localMcpServers.${index}.id`)}
                      />
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="grid gap-2">
                          <Label htmlFor={`local-mcp-name-${index}`}>
                            Name
                          </Label>
                          <Input
                            id={`local-mcp-name-${index}`}
                            placeholder="playwright"
                            {...form.register(`localMcpServers.${index}.name`, {
                              required: true,
                            })}
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor={`local-mcp-command-${index}`}>
                            Command
                          </Label>
                          <Input
                            id={`local-mcp-command-${index}`}
                            placeholder="npx"
                            {...form.register(
                              `localMcpServers.${index}.command`,
                              { required: true },
                            )}
                          />
                        </div>
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor={`local-mcp-description-${index}`}>
                          Description
                        </Label>
                        <Input
                          id={`local-mcp-description-${index}`}
                          placeholder="Browser automation on the local machine"
                          {...form.register(
                            `localMcpServers.${index}.description`,
                          )}
                        />
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="grid gap-2">
                          <Label htmlFor={`local-mcp-args-${index}`}>
                            Arguments
                          </Label>
                          <Textarea
                            id={`local-mcp-args-${index}`}
                            rows={3}
                            placeholder={
                              "One argument per line\n-y\n@playwright/mcp"
                            }
                            {...form.register(`localMcpServers.${index}.args`)}
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor={`local-mcp-env-${index}`}>
                            Environment variables
                          </Label>
                          <Textarea
                            id={`local-mcp-env-${index}`}
                            rows={3}
                            placeholder="API_TOKEN, WORKSPACE_ID"
                            {...form.register(
                              `localMcpServers.${index}.envVarNames`,
                            )}
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-2 text-sm">
                          <Checkbox
                            id={`local-mcp-optional-${index}`}
                            checked={form.watch(
                              `localMcpServers.${index}.optional`,
                            )}
                            onCheckedChange={(checked) =>
                              form.setValue(
                                `localMcpServers.${index}.optional`,
                                checked === true,
                                { shouldDirty: true },
                              )
                            }
                          />
                          <Label htmlFor={`local-mcp-optional-${index}`}>
                            Adopters may deselect this server
                          </Label>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${form.watch(`localMcpServers.${index}.name`) || "local MCP server"}`}
                          onClick={() => localMcpServers.remove(index)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
        <WizardFooter>
          <Button type="button" variant="outline" onClick={guard.requestClose}>
            <span>Cancel</span>
          </Button>
          <div className="flex gap-2">
            {step === "capabilities" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => navigateStep("details")}
              >
                <span>Back</span>
              </Button>
            ) : null}
            {step === "details" ? (
              <Button
                type="button"
                disabled={!form.watch("name").trim()}
                onClick={() => navigateStep("capabilities")}
              >
                <span>Continue</span>
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={pending || !form.watch("name").trim()}
              >
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                <span>{bundle ? "Save changes" : "Create bundle"}</span>
              </Button>
            )}
          </div>
        </WizardFooter>
      </form>
      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={guard.keepEditing}
        onDiscard={guard.discardChanges}
      />
    </PageLayout>
  );
}

function BundleEditorLoading({ title }: { title: string }) {
  return (
    <PageLayout title={title} maxWidth="wizard">
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    </PageLayout>
  );
}
