"use client";

import {
  type archestraApiTypes,
  INPUT_MODALITY_OPTIONS,
  type ModelInputModality,
  type ModelOutputModality,
  OUTPUT_MODALITY_OPTIONS,
  SUPPORTED_EMBEDDING_DIMENSIONS,
} from "@archestra/shared";
import { AlertCircle, Boxes, Globe, RotateCcw, Users } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { GroupedNumberInput } from "@/components/ui/grouped-number-input";
import { Input } from "@/components/ui/input";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  UserShareField,
  useUserShareOption,
} from "@/components/user-share-field";
import {
  TeamVisibilityPicker,
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { type ModelWithApiKeys, useUpdateModel } from "@/lib/llm-models.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useOrganization } from "@/lib/organization.query";
import { useAssignableTeams } from "@/lib/teams/team.query";
import { formatThousands } from "@/lib/utils";
import {
  buildConfiguredParameters,
  type ConfiguredParametersFormValues,
  getConfiguredParameterDefaults,
  isKnowledgeBaseEmbeddingModel,
  type OLLAMA_NATIVE_PARAM_RULES,
  parseCustomTokenLimit,
  validateConfiguredParameter,
  validateCustomTokenLimit,
} from "../models-page-utils";

/**
 * The dialog's pages, in sidebar order. Each one owns a slice of the catalog
 * entry; the model's identity lives in the sidebar header rather than taking up
 * a page of its own.
 */
type ModelDialogSection =
  | "availability"
  | "pricing"
  | "limits"
  | "modalities"
  | "embedding"
  | "parameters";

/**
 * Which page owns each form field, used to open the page holding a rejected
 * value. Without it a blocked save points at a message on a page the user
 * cannot see.
 */
const SECTION_BY_FIELD: Record<string, ModelDialogSection> = {
  ignored: "availability",
  teamIds: "availability",
  userIds: "availability",
  accessScope: "availability",
  customPricePerMillionInput: "pricing",
  customPricePerMillionOutput: "pricing",
  customPricePerMillionCacheRead: "pricing",
  customPricePerMillionCacheWrite: "pricing",
  customContextLength: "limits",
  customOutputLength: "limits",
  inputModalities: "modalities",
  outputModalities: "modalities",
  embeddingDimensions: "embedding",
  configuredParameters: "parameters",
};

/**
 * A dialog page. Inactive pages are hidden rather than unmounted: react-hook-form
 * skips validation for fields that are not mounted, so unmounting them would let
 * a value rejected on one page reach the update route as soon as the user
 * switched to another.
 */
function DialogSection({
  id,
  activeSection,
  children,
}: {
  id: ModelDialogSection;
  activeSection: ModelDialogSection;
  children: React.ReactNode;
}) {
  return (
    <div hidden={id !== activeSection} className="space-y-4">
      {children}
    </div>
  );
}

type UpdateModelBody = archestraApiTypes.UpdateModelData["body"];
type UpdateModelEmbeddingDimensions = NonNullable<
  UpdateModelBody["embeddingDimensions"]
>;

const EMBEDDING_DIMENSION_MAP = {
  "384": 384,
  "768": 768,
  "1024": 1024,
  "1536": 1536,
  "3072": 3072,
} satisfies Record<string, UpdateModelEmbeddingDimensions>;
const NOT_EMBEDDING_MODEL_VALUE = "none";

type EditModelEmbeddingDimensionsValue =
  | ""
  | keyof typeof EMBEDDING_DIMENSION_MAP;

// "user" shares the model with named individuals — the finer-grained peer of a
// team restriction. Stored as grants beside the team list, not as a scope.
type ModelAccessScope = "everyone" | "team" | "user";

const modelAccessScopeOptions: VisibilityOption<ModelAccessScope>[] = [
  {
    value: "everyone",
    label: "Everyone",
    description: "All members of the organization can see and use this model.",
    icon: Globe,
  },
  {
    value: "team",
    label: "Specific teams",
    description:
      "Only members of the selected teams can see and use this model.",
    icon: Users,
  },
];

interface EditModelFormValues {
  customPricePerMillionInput: string;
  customPricePerMillionOutput: string;
  customPricePerMillionCacheRead: string;
  customPricePerMillionCacheWrite: string;
  customContextLength: string;
  customOutputLength: string;
  ignored: boolean;
  accessScope: ModelAccessScope;
  teamIds: string[];
  userIds: string[];
  embeddingDimensions: EditModelEmbeddingDimensionsValue;
  inputModalities: string[];
  outputModalities: string[];
  configuredParameters: ConfiguredParametersFormValues;
}

export function EditModelDialog({
  model,
  open,
  onOpenChange,
}: {
  model: ModelWithApiKeys;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const appName = useAppName();
  const [activeSection, setActiveSection] =
    useState<ModelDialogSection>("availability");
  const [_inputModalityToAdd, _setInputModalityToAdd] = useState("");
  const [_outputModalityToAdd, _setOutputModalityToAdd] = useState("");
  const updateModel = useUpdateModel();
  const [labels, setLabels] = useState<ProfileLabel[]>(model.labels);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  // Model catalog managers restrict models across the whole org, so the
  // picker offers every team (not just the editor's own).
  const { data: assignableTeams = [] } = useAssignableTeams({
    isResourceAdmin: true,
    enabled: !!canReadTeams,
  });
  const { data: organization } = useOrganization();
  const { data: apiKeys = [] } = useLlmProviderApiKeys();
  const providerConfig = PROVIDER_CONFIG[model.provider];
  const embeddingConfigLocked = isKnowledgeBaseEmbeddingModel({
    model,
    embeddingModel: organization?.embeddingModel,
    embeddingChatApiKeyId: organization?.embeddingChatApiKeyId,
    availableApiKeys: apiKeys,
  });
  const fallbackPricing = getFallbackPricing(model);
  const teamScopeUnavailable = !canReadTeams || assignableTeams.length === 0;
  const userShareOption = useUserShareOption<ModelAccessScope>("user");
  const accessScopeOptions: VisibilityOption<ModelAccessScope>[] = [
    ...modelAccessScopeOptions.map((option) =>
      option.value === "team" && teamScopeUnavailable
        ? {
            ...option,
            disabled: true,
            disabledLabel: !canReadTeams
              ? "Requires permission"
              : "No teams available",
            disabledReason: !canReadTeams
              ? "Team selection requires permission to view teams."
              : "There are no teams to share with yet. Create one from Settings → Teams.",
          }
        : option,
    ),
    // Shown even with nobody to share with, disabled and explained, so the
    // capability is discoverable rather than silently absent.
    { ...userShareOption, label: "Specific people" },
  ];
  // The model's provider supports prompt caching when the backend resolved a
  // cache price for it (synced, custom, or multiplier-derived).
  const supportsCachePricing = model.cachePriceSource !== null;
  const nonNegativePriceRule = {
    validate: (v: string) => {
      if (!v) return true;
      const n = parseFloat(v);
      if (Number.isNaN(n) || n < 0) return "Must be a non-negative number";
      return true;
    },
  };
  const form = useForm<EditModelFormValues>({
    defaultValues: getDefaults(model),
  });
  const selectedEmbeddingDimensions = form.watch("embeddingDimensions");
  const accessScope = form.watch("accessScope");
  // The `num_ctx` ceiling follows the window currently entered in this dialog,
  // not the saved one: the update route validates the post-patch pair, so
  // raising the window and `num_ctx` in one save has to pass here too.
  const contextCeiling =
    parseCustomTokenLimit(form.watch("customContextLength")) ??
    model.contextLength;

  // An embedding model whose embedding client is text-only can't take image
  // input — the backend rejects the save, so disable the option here with the
  // reason instead of letting the form run into a 400.
  const imageInputUnavailable =
    !!selectedEmbeddingDimensions &&
    model.embeddingClientImageCapable === false;
  // Rows synced without modality metadata (providers whose catalog reports
  // none) carry null modality lists. Requiring modalities on those rows would
  // block unrelated edits — a price-only save must not force the admin to
  // invent modality data first. Once modalities are recorded, clearing a
  // required list entirely stays invalid.
  const hadInputModalities = (model.inputModalities ?? []).length > 0;
  const hadOutputModalities = (model.outputModalities ?? []).length > 0;
  const inputModalityOptions = INPUT_MODALITY_OPTIONS.map((option) =>
    imageInputUnavailable && option.value === "image"
      ? {
          value: option.value,
          label: option.label,
          disabled: true,
          description:
            "Unavailable: the embedding client for this model supports text input only.",
        }
      : {
          value: option.value,
          label: option.label,
          description: option.description,
        },
  );
  const outputModalityOptions = OUTPUT_MODALITY_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
  }));

  // Top-level field errors, surfaced next to the submit button — see the footer
  // for why. Nested `configuredParameters.*` errors are deliberately not
  // included: those inputs spread `field` onto a real DOM node, so
  // react-hook-form focuses and scrolls to them on its own.
  const blockingErrors = Object.values(form.formState.errors)
    .map((error) => (error as { message?: string } | undefined)?.message)
    .filter((message): message is string => Boolean(message));

  useEffect(() => {
    if (open) {
      form.reset(getDefaults(model));
      setLabels(model.labels);
      setActiveSection("availability");
    }
  }, [open, model, form]);

  const handleSubmit = async (values: EditModelFormValues) => {
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
    const inputPrice = values.customPricePerMillionInput.trim() || null;
    const outputPrice = values.customPricePerMillionOutput.trim() || null;
    const cacheReadPrice = values.customPricePerMillionCacheRead.trim() || null;
    const cacheWritePrice =
      values.customPricePerMillionCacheWrite.trim() || null;
    const embeddingDimensions = getEmbeddingDimensionsValue(
      values.embeddingDimensions,
    );

    const result = await updateModel.mutateAsync({
      id: model.id,
      customPricePerMillionInput: inputPrice,
      customPricePerMillionOutput: outputPrice,
      customPricePerMillionCacheRead: cacheReadPrice,
      customPricePerMillionCacheWrite: cacheWritePrice,
      // Empty clears the override, which is how the provider's own figure
      // becomes visible again after one has been set.
      customContextLength: parseCustomTokenLimit(values.customContextLength),
      customOutputLength: parseCustomTokenLimit(values.customOutputLength),
      ignored: values.ignored,
      labels: finalLabels,
      // Both lists always go, so switching between Teams and Users revokes
      // what the previous choice left behind instead of stranding it.
      teamIds: values.accessScope === "team" ? values.teamIds : [],
      userIds: values.accessScope === "user" ? values.userIds : [],
      embeddingDimensions,
      // Sent only when actually changed: a row synced without modality
      // metadata stores null, and a price-only save must not coerce that null
      // into an empty list (null reads as "unknown" downstream, [] as
      // "known: none").
      ...(sameModalities(values.inputModalities, model.inputModalities ?? [])
        ? {}
        : { inputModalities: values.inputModalities as ModelInputModality[] }),
      ...(sameModalities(values.outputModalities, model.outputModalities ?? [])
        ? {}
        : {
            outputModalities: values.outputModalities as ModelOutputModality[],
          }),
      // Configured parameters are only applied by the native Ollama provider;
      // for other providers leave the field untouched. Sent only when actually
      // edited: the update replaces the object wholesale, so including it on an
      // unrelated save (a price tweak) would rewrite parameters the form no
      // longer renders — `seed` among them.
      ...(model.provider === "ollama-native" &&
      form.formState.dirtyFields.configuredParameters
        ? {
            configuredParameters: buildConfiguredParameters(
              values.configuredParameters,
              model.configuredParameters,
            ),
          }
        : {}),
    });
    if (result) {
      onOpenChange(false);
    }
  };

  const handleResetPricing = () => {
    form.setValue("customPricePerMillionInput", "");
    form.setValue("customPricePerMillionOutput", "");
    form.setValue("customPricePerMillionCacheRead", "");
    form.setValue("customPricePerMillionCacheWrite", "");
  };

  // Parameters are Ollama-only: the native transport sends them, and the
  // OpenAI-compatible one reports the defaults this page displays.
  const showsParameters =
    model.provider === "ollama-native" ||
    (model.provider === "ollama" &&
      !!model.defaultParameters &&
      Object.keys(model.defaultParameters).length > 0);

  const navItems = useMemo(
    () => [
      { id: "availability" as const, label: "Availability" },
      { id: "pricing" as const, label: "Pricing" },
      { id: "limits" as const, label: "Limits" },
      { id: "modalities" as const, label: "Modalities" },
      { id: "embedding" as const, label: "Embedding" },
      ...(showsParameters
        ? [{ id: "parameters" as const, label: "Parameters" }]
        : []),
    ],
    [showsParameters],
  );

  // A rejected field is useless on a page the user cannot see, so the first one
  // brings its page forward.
  const showFirstInvalidSection = () => {
    const firstInvalidField = Object.keys(form.formState.errors).find(
      (field) => field in SECTION_BY_FIELD,
    );
    if (firstInvalidField) {
      setActiveSection(SECTION_BY_FIELD[firstInvalidField]);
    }
  };

  return (
    <TabbedDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Model"
      description={`Update the catalog entry for "${model.modelId}".`}
      sidebarLabel={model.modelId}
      sidebarDescription={providerConfig?.name ?? model.provider}
      sidebarIcon={
        providerConfig ? (
          <Image
            src={providerConfig.icon}
            alt={providerConfig.name}
            width={16}
            height={16}
            className="rounded dark:invert"
          />
        ) : (
          <Boxes className="h-4 w-4 text-muted-foreground" />
        )
      }
      activeSection={activeSection}
      navItems={navItems}
      onActiveSectionChange={setActiveSection}
      onSubmit={form.handleSubmit(handleSubmit, showFirstInvalidSection)}
      wrapForm={(formContent) => <Form {...form}>{formContent}</Form>}
      footer={
        <>
          {/* The dialog body scrolls while this footer is pinned, so a field
              error can render hundreds of pixels above the fold — and the
              modality fields never forward a ref, so react-hook-form cannot
              scroll to them either. Without this, a blocked submit looks
              exactly like a button that does nothing. */}
          {blockingErrors.length > 0 && (
            <p
              role="alert"
              className="mr-auto text-sm text-destructive"
              data-testid="edit-model-form-errors"
            >
              {blockingErrors.join(". ")}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={updateModel.isPending}>
            {updateModel.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </>
      }
    >
      <DialogSection id="availability" activeSection={activeSection}>
        {/* Availability: hide toggle + team restriction */}
        <div className="space-y-3">
          <div className="space-y-1">
            <span className="text-sm font-medium">Availability</span>
            <p className="text-sm text-muted-foreground">
              Control who can see and use this model.
            </p>
          </div>

          <FormField
            control={form.control}
            name="ignored"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-1">
                    <FormLabel>Hide this model</FormLabel>
                    <p className="text-sm text-muted-foreground">
                      Hidden models remain synced and editable in this catalog,
                      but they are excluded anywhere {appName} offers model
                      selection.
                    </p>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </div>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="teamIds"
            rules={{
              validate: (teamIds) =>
                form.getValues("accessScope") === "team" && teamIds.length === 0
                  ? "Select at least one team"
                  : true,
            }}
            render={({ field }) => (
              <FormItem>
                <VisibilitySelector
                  label="Who can use this model"
                  value={accessScope}
                  options={accessScopeOptions}
                  onValueChange={(scope) => {
                    form.setValue("accessScope", scope);
                    // Re-run the teamIds rule so a stale "select at least
                    // one team" error clears when switching back.
                    void form.trigger("teamIds");
                  }}
                >
                  {accessScope === "user" && (
                    <UserShareField
                      value={form.watch("userIds")}
                      onValueChange={(ids) => {
                        form.setValue("userIds", ids);
                        void form.trigger("userIds");
                      }}
                      label="People"
                    />
                  )}

                  {accessScope === "team" && (
                    <FormControl>
                      <TeamVisibilityPicker
                        disabled={!canReadTeams || assignableTeams.length === 0}
                        teams={assignableTeams}
                        value={field.value}
                        onChange={field.onChange}
                        required
                        unavailableMessage={
                          !canReadTeams
                            ? "Teams unavailable"
                            : assignableTeams.length === 0
                              ? "No teams available"
                              : undefined
                        }
                      />
                    </FormControl>
                  )}
                </VisibilitySelector>
                <FormMessage />
              </FormItem>
            )}
          />
          <AdvancedLabelsSection
            ref={labelsRef}
            labels={labels}
            onLabelsChange={setLabels}
          />
        </div>
      </DialogSection>

      <DialogSection id="pricing" activeSection={activeSection}>
        {/* Pricing */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">
              Custom Pricing ($/M tokens)
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={handleResetPricing}
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField
              control={form.control}
              name="customPricePerMillionInput"
              rules={nonNegativePriceRule}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Input</FormLabel>
                  <FormControl>
                    <Input placeholder={fallbackPricing.input} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="customPricePerMillionOutput"
              rules={nonNegativePriceRule}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Output</FormLabel>
                  <FormControl>
                    <Input placeholder={fallbackPricing.output} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          {model.priceSource === "default" && (
            <p className="text-xs text-muted-foreground">
              Input/output prices are estimated — set a custom price for
              accurate cost tracking.
            </p>
          )}
          {supportsCachePricing && (
            <div className="space-y-2 pt-2">
              <div className="flex min-h-7 items-center">
                <span className="text-sm font-medium">
                  Cache Pricing ($/M tokens)
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="customPricePerMillionCacheRead"
                  rules={nonNegativePriceRule}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Cache read</FormLabel>
                      <FormControl>
                        <Input
                          placeholder={fallbackPricing.cacheRead}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="customPricePerMillionCacheWrite"
                  rules={nonNegativePriceRule}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Cache write</FormLabel>
                      <FormControl>
                        <Input
                          placeholder={fallbackPricing.cacheWrite}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              {model.cachePriceSource === "derived_multiplier" && (
                <p className="text-xs text-muted-foreground">
                  Cache prices are estimated from the input price. Set a custom
                  cache price to override.
                </p>
              )}
            </div>
          )}
        </div>
      </DialogSection>

      <DialogSection id="limits" activeSection={activeSection}>
        {/* Context window + max output tokens */}
        <div className="space-y-3">
          <div className="space-y-1">
            <span className="text-sm font-medium">Limits</span>
            <p className="text-sm text-muted-foreground">
              The context window and output ceiling {appName} assumes for this
              model. Leave a field empty to use whatever the provider reports;
              set it when the provider reports nothing, or reports a value that
              does not match how this model is actually served.
            </p>
          </div>
          {model.contextLength === null && model.outputLength === null && (
            <p className="text-xs text-muted-foreground">
              This provider reports neither limit for this model, so chat
              context usage and output budgets fall back to conservative
              defaults until you set them here.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <FormField
              control={form.control}
              name="customContextLength"
              rules={{ validate: validateCustomTokenLimit }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Context window (tokens)</FormLabel>
                  <FormControl>
                    <GroupedNumberInput
                      placeholder={providerLimitPlaceholder(
                        model.contextLength,
                      )}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="customOutputLength"
              rules={{ validate: validateCustomTokenLimit }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Max output tokens</FormLabel>
                  <FormControl>
                    <GroupedNumberInput
                      placeholder={providerLimitPlaceholder(model.outputLength)}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>
      </DialogSection>

      <DialogSection id="modalities" activeSection={activeSection}>
        <div className="space-y-3">
          <div className="space-y-1">
            <span className="text-sm font-medium">Modalities</span>
            <p className="text-sm text-muted-foreground">
              These settings describe what the model can accept as input and
              what it can produce as output.
            </p>
          </div>
          <Alert>
            <AlertCircle />
            <AlertTitle>How {appName} chat support is determined</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Text input means the model can accept normal chat prompts. In{" "}
                  {appName} chat, it also enables text-based uploads such as{" "}
                  <code>.txt</code> and <code>.csv</code>, which are passed to
                  the model as text content. Text output means the model can
                  return standard chat responses.
                </li>
                <li>
                  In {appName} chat, a model appears as a standard chat model
                  when it supports both text input and text output and is not
                  hidden.
                </li>
                <li>
                  Image, audio, video, and PDF input modalities control whether
                  chat file upload is enabled for the model and which uploaded
                  file types are accepted.
                </li>
                <li>
                  Output modalities describe the response formats the model can
                  generate, but they do not enable file uploads by themselves.
                </li>
              </ul>
            </AlertDescription>
          </Alert>

          <div className="grid items-start gap-3 md:grid-cols-2">
            <FormField
              control={form.control}
              name="inputModalities"
              rules={{
                validate: (v) => {
                  if (v.length === 0 && hadInputModalities) {
                    return "At least one input modality is required";
                  }
                  if (imageInputUnavailable && v.includes("image")) {
                    return "The embedding client for this model supports text input only — remove the Image input modality or unset the embedding dimensions.";
                  }
                  return true;
                },
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Input</FormLabel>
                  <FormControl>
                    <MultiSelectCombobox
                      options={inputModalityOptions}
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="Add input modality…"
                      emptyMessage="No modalities found."
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="outputModalities"
              rules={{
                validate: (v) =>
                  shouldRequireOutputModalities(selectedEmbeddingDimensions) &&
                  hadOutputModalities
                    ? v.length > 0 || "At least one output modality is required"
                    : true,
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Output</FormLabel>
                  <FormControl>
                    <MultiSelectCombobox
                      options={outputModalityOptions}
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="Add output modality…"
                      emptyMessage="No modalities found."
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>
      </DialogSection>

      <DialogSection id="embedding" activeSection={activeSection}>
        <div className="space-y-3">
          <div className="space-y-1">
            <span className="text-sm font-medium">Embedding</span>
            <p className="text-sm text-muted-foreground">
              Set embedding dimensions to make this model available for
              knowledge base embeddings. Leave it unset for chat-only models.
              This must match the vector size the provider returns or the size
              you intentionally truncate to.
            </p>
          </div>

          <Alert>
            <AlertCircle />
            <AlertTitle>How embedding input modalities are used</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Input modalities control which source content types can be
                  sent to this model when {appName} generates embeddings for
                  knowledge connectors and uploaded files.
                </li>
                <li>
                  Text input enables text-based content such as documents,
                  pages, and extracted file text.
                </li>
                <li>
                  Image input enables image files to be considered for embedding
                  when the connector and model both support it.
                </li>
                <li>
                  Output modalities are not required for embedding-only models.
                </li>
              </ul>
            </AlertDescription>
          </Alert>

          <FormField
            control={form.control}
            name="embeddingDimensions"
            render={({ field }) => (
              <FormItem>
                <Select
                  value={field.value || NOT_EMBEDDING_MODEL_VALUE}
                  disabled={embeddingConfigLocked}
                  onValueChange={(value) =>
                    field.onChange(
                      value === NOT_EMBEDDING_MODEL_VALUE ? "" : value,
                    )
                  }
                >
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Not an embedding model" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NOT_EMBEDDING_MODEL_VALUE}>
                      Not an embedding model
                    </SelectItem>
                    {SUPPORTED_EMBEDDING_DIMENSIONS.map((dimension) => (
                      <SelectItem key={dimension} value={dimension.toString()}>
                        {dimension}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {embeddingConfigLocked && (
                  <p className="text-sm text-muted-foreground">
                    This model is used for knowledge base embeddings, so its
                    embedding configuration is locked. To change it, drop the
                    embedding configuration in{" "}
                    <Link
                      href="/settings/knowledge"
                      className="underline underline-offset-2"
                    >
                      Knowledge settings
                    </Link>{" "}
                    first — all documents will need to be re-embedded.
                  </p>
                )}
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </DialogSection>

      <DialogSection id="parameters" activeSection={activeSection}>
        {model.provider === "ollama" &&
          model.defaultParameters &&
          Object.keys(model.defaultParameters).length > 0 && (
            <div className="space-y-2">
              <span className="text-sm font-medium">Default parameters</span>
              <p className="text-sm text-muted-foreground">
                Defaults reported by Ollama for this model, shown for reference.{" "}
                {appName} does not apply them to requests.
              </p>
              <dl className="divide-y rounded-lg border text-sm">
                {Object.entries(model.defaultParameters).map(([key, value]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-4 px-3 py-2"
                  >
                    <dt className="font-mono text-muted-foreground">{key}</dt>
                    <dd className="font-mono">
                      {Array.isArray(value) ? value.join(", ") : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

        {model.provider === "ollama-native" && (
          <div className="space-y-3">
            <div className="space-y-1">
              <span className="text-sm font-medium">Model parameters</span>
              <p className="text-sm text-muted-foreground">
                Sent to Ollama on every chat turn. Leave a field empty to
                inherit Ollama's own default
                {model.defaultParameters &&
                Object.keys(model.defaultParameters).length > 0
                  ? " (shown as the placeholder)."
                  : "."}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {OLLAMA_NATIVE_PARAM_FIELDS.map((param) => (
                <FormField
                  key={param.name}
                  control={form.control}
                  name={`configuredParameters.${param.name}`}
                  rules={{
                    validate: (value: string) =>
                      validateConfiguredParameter({
                        name: param.name,
                        value,
                        contextLength: contextCeiling,
                      }),
                  }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono text-xs">
                        {param.name}
                      </FormLabel>
                      <FormControl>
                        <Input
                          inputMode="decimal"
                          placeholder={ollamaDefaultPlaceholder(
                            model,
                            param.name,
                          )}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="configuredParameters.stop"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono text-xs">stop</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={3}
                        placeholder={ollamaDefaultPlaceholder(model, "stop")}
                        {...field}
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      One sequence per line.
                    </p>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="configuredParameters.reasoning_effort"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Thinking</FormLabel>
                    <Select
                      // Rows saved before this control collapsed to on/off
                      // still hold "low"/"high"; both mean thinking is on.
                      value={
                        field.value
                          ? field.value === "none"
                            ? "none"
                            : "medium"
                          : "inherit"
                      }
                      onValueChange={(value) =>
                        field.onChange(value === "inherit" ? "" : value)
                      }
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Inherit" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {/* Ollama's `think` is a boolean on this provider,
                                so low/medium/high would all be identical on the
                                wire — offering them implied a granularity that
                                does not exist. */}
                        <SelectItem value="inherit">Inherit</SelectItem>
                        <SelectItem value="medium">On</SelectItem>
                        <SelectItem value="none">Off</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Thinking-capable models only. "Inherit" uses Ollama's own
                      default.
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </div>
        )}
      </DialogSection>
    </TabbedDialogShell>
  );
}

/**
 * Placeholder prices shown in the custom-price inputs: the backend's resolved
 * effective price (synced or estimated) for input/output, and the resolved
 * cache prices (null when the model's provider has no cache pricing). The
 * effective price equals the custom override when one is set, but in that case
 * the input is non-empty so the placeholder is not shown.
 */
function getFallbackPricing(model: ModelWithApiKeys): {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
} {
  return {
    input: model.pricePerMillionInput ?? "",
    output: model.pricePerMillionOutput ?? "",
    cacheRead: model.pricePerMillionCacheRead ?? "",
    cacheWrite: model.pricePerMillionCacheWrite ?? "",
  };
}

/**
 * Placeholder for a limit input: the provider's own figure, or a note that it
 * published none. An empty field means "use the provider's value", so the
 * placeholder has to say what that value is — including when there isn't one.
 */
function providerLimitPlaceholder(value: number | null): string {
  return value === null
    ? "Not reported by the provider"
    : formatThousands(value);
}

function sameModalities(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((modality) => b.includes(modality));
}

function getDefaults(model: ModelWithApiKeys): EditModelFormValues {
  return {
    customPricePerMillionInput: model.customPricePerMillionInput ?? "",
    customPricePerMillionOutput: model.customPricePerMillionOutput ?? "",
    customPricePerMillionCacheRead: model.customPricePerMillionCacheRead ?? "",
    customPricePerMillionCacheWrite:
      model.customPricePerMillionCacheWrite ?? "",
    customContextLength: model.customContextLength?.toString() ?? "",
    customOutputLength: model.customOutputLength?.toString() ?? "",
    ignored: model.ignored,
    accessScope:
      model.teams.length > 0 ? ("team" as const) : ("everyone" as const),
    teamIds: model.teams.map((team) => team.id),
    userIds: model.users?.map((user) => user.id) ?? [],
    embeddingDimensions: model.embeddingDimensions
      ? getEmbeddingDimensionsString(model.embeddingDimensions)
      : "",
    inputModalities: model.inputModalities ?? [],
    outputModalities: model.outputModalities ?? [],
    configuredParameters: getConfiguredParameterDefaults(model),
  };
}

function getEmbeddingDimensionsString(
  value: UpdateModelEmbeddingDimensions,
): EditModelEmbeddingDimensionsValue {
  if (value === 384) return "384";
  if (value === 768) return "768";
  if (value === 1024) return "1024";
  if (value === 1536) return "1536";
  if (value === 3072) return "3072";
  return "";
}

function getEmbeddingDimensionsValue(
  value: EditModelEmbeddingDimensionsValue,
): UpdateModelEmbeddingDimensions | null {
  if (!value) {
    return null;
  }

  return EMBEDDING_DIMENSION_MAP[value];
}

function shouldRequireOutputModalities(
  embeddingDimensions: EditModelEmbeddingDimensionsValue,
): boolean {
  return !embeddingDimensions;
}

/**
 * The numeric native-Ollama parameters rendered as a grid in the model dialog.
 * `stop` (a newline-delimited textarea) and `reasoning_effort` (a select) are
 * rendered separately.
 */
const OLLAMA_NATIVE_PARAM_FIELDS: Array<{
  name: keyof typeof OLLAMA_NATIVE_PARAM_RULES;
}> = [
  { name: "num_ctx" },
  { name: "num_predict" },
  { name: "temperature" },
  { name: "top_p" },
  { name: "top_k" },
  { name: "repeat_penalty" },
];

function ollamaDefaultPlaceholder(
  model: ModelWithApiKeys,
  name: string,
): string {
  const value = model.defaultParameters?.[name];
  if (value === undefined || value === null) return "inherit";
  // Newline-joined, matching the delimiter `buildConfiguredParameters` parses.
  // `/api/show` routinely reports several `stop` sequences, and a comma-joined
  // placeholder invited admins to copy it back in as one sequence containing a
  // comma — the exact value the newline switch was made to stop producing.
  return Array.isArray(value) ? value.join("\n") : String(value);
}
