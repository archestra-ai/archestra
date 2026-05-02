"use client";

import { PROVIDERS_WITH_OPTIONAL_API_KEY } from "@shared";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { FormDialog } from "@/components/form-dialog";
import {
  LLM_PROVIDER_API_KEY_PLACEHOLDER,
  LlmProviderApiKeyForm,
  type LlmProviderApiKeyFormValues,
  serializeExtraHeaders,
} from "@/components/llm-provider-api-key-form";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { useFeature } from "@/lib/config/config.query";
import {
  useCreateLlmProviderApiKey,
  useLlmProviderApiKeys,
} from "@/lib/llm-provider-api-keys.query";

export type CreateLlmProviderApiKeyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  defaultValues?: Partial<LlmProviderApiKeyFormValues>;
  showConsoleLink?: boolean;
  onSuccess?: () => void;
};

export function CreateLlmProviderApiKeyDialog({
  open,
  onOpenChange,
  title,
  description,
  defaultValues,
  showConsoleLink = false,
  onSuccess,
}: CreateLlmProviderApiKeyDialogProps) {
  const createMutation = useCreateLlmProviderApiKey();
  const { data: existingKeys = [] } = useLlmProviderApiKeys({ enabled: open });
  const byosEnabled = useFeature("byosEnabled");
  const bedrockIamAuthEnabled = useFeature("bedrockIamAuthEnabled");
  const geminiVertexAiEnabled = useFeature("geminiVertexAiEnabled");

  const form = useForm<LlmProviderApiKeyFormValues>({
    defaultValues: getDefaultFormValues(defaultValues),
  });

  useEffect(() => {
    if (!open) return;
    form.reset(getDefaultFormValues(defaultValues));
  }, [defaultValues, form, open]);

  const formValues = form.watch();
  const isValid = getIsCreateFormValid({
    byosEnabled: Boolean(byosEnabled),
    values: formValues,
  });

  const handleCreate = form.handleSubmit(async (values) => {
    try {
      await createMutation.mutateAsync({
        name: values.name,
        provider: values.provider,
        apiKey: values.apiKey || undefined,
        baseUrl: values.baseUrl || undefined,
        extraHeaders: serializeExtraHeaders(values.extraHeaders) ?? undefined,
        scope: values.scope,
        teamId:
          values.scope === "team" && values.teamId ? values.teamId : undefined,
        isPrimary: values.isPrimary,
        vaultSecretPath:
          byosEnabled && values.vaultSecretPath
            ? values.vaultSecretPath
            : undefined,
        vaultSecretKey:
          byosEnabled && values.vaultSecretKey
            ? values.vaultSecretKey
            : undefined,
      });
      onOpenChange(false);
      onSuccess?.();
    } catch {
      // Error handled by mutation
    }
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="small"
    >
      <DialogForm
        onSubmit={handleCreate}
        className="flex min-h-0 flex-1 flex-col"
      >
        <DialogBody>
          <LlmProviderApiKeyForm
            mode="full"
            showConsoleLink={showConsoleLink}
            form={form}
            existingKeys={existingKeys}
            isPending={createMutation.isPending}
            bedrockIamAuthEnabled={bedrockIamAuthEnabled}
            geminiVertexAiEnabled={geminiVertexAiEnabled}
          />
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!isValid || createMutation.isPending}>
            {createMutation.isPending && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            Test & Create
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

function getDefaultFormValues(
  defaultValues?: Partial<LlmProviderApiKeyFormValues>,
): LlmProviderApiKeyFormValues {
  return {
    name: "",
    provider: "anthropic",
    apiKey: null,
    baseUrl: null,
    extraHeaders: [],
    scope: "personal",
    teamId: null,
    vaultSecretPath: null,
    vaultSecretKey: null,
    isPrimary: false,
    ...defaultValues,
  };
}

function getIsCreateFormValid(params: {
  byosEnabled: boolean;
  values: LlmProviderApiKeyFormValues;
}) {
  const { byosEnabled, values } = params;

  return Boolean(
    values.apiKey !== LLM_PROVIDER_API_KEY_PLACEHOLDER &&
      values.name &&
      (values.scope !== "team" || values.teamId) &&
      (byosEnabled
        ? values.vaultSecretPath && values.vaultSecretKey
        : PROVIDERS_WITH_OPTIONAL_API_KEY.has(values.provider) ||
          values.apiKey),
  );
}
