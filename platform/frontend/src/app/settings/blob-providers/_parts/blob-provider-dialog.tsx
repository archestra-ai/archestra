"use client";

import {
  BLOB_PROVIDER_TYPE_LABELS,
  type BlobProviderType,
} from "@archestra/shared";
import { AlertTriangle } from "lucide-react";
import { useEffect, useRef } from "react";
import { AdvancedSection } from "@/components/advanced-section";
import { blobProviderLogoSrc } from "@/components/blob-provider-logo";
import { FormDialog } from "@/components/form-dialog";
import { LlmProviderOptionLabel } from "@/components/llm-provider-select-items";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { SecretInput, SecretTextarea } from "@/components/ui/secret-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { BlobProvider } from "@/lib/blob-provider.query";
import {
  BLOB_PROVIDER_AUTH_HINTS,
  BLOB_PROVIDER_AUTH_LABELS,
  BLOB_PROVIDER_TYPE_HINTS,
  BLOB_PROVIDER_TYPES,
  type BlobProviderFormValues,
  useBlobProviderForm,
} from "./use-blob-provider-form";

/**
 * Create a blob provider, or edit one. Only what most setups need is shown;
 * prefixes, custom endpoints and optional identity settings sit under
 * Advanced. Saving first writes and deletes a test object; a failure stays in
 * the dialog with the provider's own error and can be saved anyway.
 * Credentials are write-only.
 */
export function BlobProviderDialog({
  open,
  onOpenChange,
  provider,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The provider being edited; null creates one. */
  provider: BlobProvider | null;
  /** Called with the provider once it saves. */
  onSaved?: (saved: BlobProvider) => void;
}) {
  const form = useBlobProviderForm({
    open,
    provider,
    onSaved: (saved) => {
      onOpenChange(false);
      onSaved?.(saved);
    },
  });
  const { id, values, set, keepsStored, saving, failure, submit } = form;
  const text = form.input;
  const field = (name: keyof BlobProviderFormValues, label: string) => ({
    id: `${id}-${name}`,
    label,
    error: form.errorFor(name),
  });

  const noticeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failure) noticeRef.current?.scrollIntoView({ block: "nearest" });
  }, [failure]);

  const isS3 = values.type === "s3";
  const isAzure = values.type === "azure_blob";
  const assumeRole = isS3 && values.authMethod === "assume_role";
  const s3Keys = isS3 && values.authMethod === "access_key";
  const usesSessionToken = form.secretFields.includes("sessionToken");

  // Open Advanced when an edited provider already uses it, when the user has
  // filled something in there, or when a field in there fails validation.
  const advancedFields: (keyof BlobProviderFormValues)[] = assumeRole
    ? [...ADVANCED_FIELDS, "accessKeyId", "secretAccessKey"]
    : [...ADVANCED_FIELDS];
  const advancedError = advancedFields.some((name) => !!form.errorFor(name));
  const advancedOpen =
    providerUsesAdvanced(provider) ||
    advancedFields.some((name) => !!values[name]) ||
    advancedError;

  const secretHint = keepsStored
    ? "Leave empty to keep the stored value."
    : "Stored in the secrets manager, never shown again.";

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={provider ? "Edit blob provider" : "Add blob provider"}
      description="A small test object is written and deleted before saving."
      size="medium"
    >
      <DialogForm
        noValidate
        onSubmit={() => {
          void submit();
        }}
      >
        <DialogBody className="space-y-5">
          <Field
            id={`${id}-type`}
            label="Provider"
            hint={
              provider
                ? "A provider's type can't be changed."
                : BLOB_PROVIDER_TYPE_HINTS[values.type]
            }
          >
            <SearchableSelect
              id={`${id}-type`}
              ariaLabel="Provider"
              className="w-full"
              showSearch={false}
              disabled={!!provider}
              value={values.type}
              onValueChange={(value) => form.setType(value as BlobProviderType)}
              items={BLOB_PROVIDER_TYPES.map((type) => ({
                value: type,
                label: BLOB_PROVIDER_TYPE_LABELS[type],
                content: (
                  <LlmProviderOptionLabel
                    icon={blobProviderLogoSrc(type)}
                    name={BLOB_PROVIDER_TYPE_LABELS[type]}
                    subtext={BLOB_PROVIDER_TYPE_HINTS[type]}
                  />
                ),
                selectedContent: (
                  <LlmProviderOptionLabel
                    icon={blobProviderLogoSrc(type)}
                    name={BLOB_PROVIDER_TYPE_LABELS[type]}
                  />
                ),
              }))}
            />
          </Field>

          <Field {...field("name", "Name")}>
            <Input {...text("name")} placeholder="FinOps exports" autoFocus />
          </Field>

          {/* Where the objects go. */}
          {isS3 && (
            <div className="grid gap-4 sm:grid-cols-[1fr_11rem]">
              <Field {...field("bucket", "Bucket")}>
                <Input {...text("bucket")} placeholder="my-finops-bucket" />
              </Field>
              <Field {...field("region", "Region")}>
                <Input {...text("region")} placeholder="us-east-1" />
              </Field>
            </div>
          )}
          {values.type === "gcs" && (
            <Field {...field("bucket", "Bucket")}>
              <Input {...text("bucket")} placeholder="my-finops-bucket" />
            </Field>
          )}
          {isAzure && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field {...field("accountName", "Storage account")}>
                <Input {...text("accountName")} placeholder="finopsexports" />
              </Field>
              <Field {...field("container", "Container")}>
                <Input {...text("container")} placeholder="cost-exports" />
              </Field>
            </div>
          )}

          {/* How the server signs in. */}
          <Field
            id={`${id}-auth`}
            label="Authentication"
            hint={BLOB_PROVIDER_AUTH_HINTS[values.type][values.authMethod]}
          >
            <Select
              value={values.authMethod}
              onValueChange={(value) => set({ authMethod: value })}
            >
              <SelectTrigger id={`${id}-auth`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(BLOB_PROVIDER_AUTH_LABELS[values.type]).map(
                  ([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </Field>

          {assumeRole && (
            <Field {...field("roleArn", "Role ARN")}>
              <Input
                {...text("roleArn")}
                placeholder="arn:aws:iam::123456789012:role/archestra-exports"
              />
            </Field>
          )}

          {s3Keys && (
            <div className="space-y-1.5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field {...field("accessKeyId", "Access key ID")}>
                  <Input {...text("accessKeyId")} />
                </Field>
                <Field {...field("secretAccessKey", "Secret access key")}>
                  <SecretInput {...text("secretAccessKey")} />
                </Field>
              </div>
              <Hint>{secretHint}</Hint>
            </div>
          )}

          {values.type === "gcs" &&
            values.authMethod === "service_account_key" && (
              <Field
                {...field("serviceAccountKey", "Service account key (JSON)")}
                hint={secretHint}
              >
                <SecretTextarea
                  id={`${id}-serviceAccountKey`}
                  value={values.serviceAccountKey}
                  onChange={(event) =>
                    set({ serviceAccountKey: event.target.value })
                  }
                  rows={4}
                  className="font-mono text-xs"
                  placeholder='{"type": "service_account", "client_email": "…", "private_key": "…"}'
                  aria-invalid={!!form.errorFor("serviceAccountKey")}
                />
              </Field>
            )}

          {isAzure && values.authMethod === "service_principal" && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field {...field("tenantId", "Tenant ID")}>
                  <Input
                    {...text("tenantId")}
                    placeholder="00000000-0000-0000-0000-000000000000"
                  />
                </Field>
                <Field {...field("clientId", "Client ID")}>
                  <Input
                    {...text("clientId")}
                    placeholder="00000000-0000-0000-0000-000000000000"
                  />
                </Field>
              </div>
              <Field
                {...field("clientSecret", "Client secret")}
                hint={secretHint}
              >
                <SecretInput {...text("clientSecret")} />
              </Field>
            </>
          )}
          {isAzure && values.authMethod === "account_key" && (
            <Field {...field("accountKey", "Account key")} hint={secretHint}>
              <SecretInput {...text("accountKey")} />
            </Field>
          )}
          {isAzure && values.authMethod === "sas_token" && (
            <Field
              {...field("sasToken", "SAS token")}
              hint={`Container-scoped, with create, write and delete permissions. ${secretHint}`}
            >
              <SecretInput {...text("sasToken")} placeholder="sv=…&sig=…" />
            </Field>
          )}

          {/* Everything optional. Remounts when it must open. */}
          <AdvancedSection
            key={`${open}-${provider?.id ?? "new"}-${values.type}-${advancedError}`}
            defaultOpen={advancedOpen}
            scrollIntoViewOnOpen
          >
            <Field
              {...field("keyPrefix", "Key prefix")}
              hint="Every object is written under this prefix."
            >
              <Input {...text("keyPrefix")} placeholder="archestra" />
            </Field>

            {(isS3 || isAzure) && (
              <Field
                {...field("endpoint", "Custom endpoint")}
                hint={
                  isS3
                    ? "Only for S3-compatible stores such as MinIO, Cloudflare R2 or Ceph."
                    : "Only for sovereign clouds or Azurite. Defaults to https://<account>.blob.core.windows.net."
                }
              >
                <Input
                  {...text("endpoint")}
                  placeholder={
                    isS3
                      ? "https://s3.example.com"
                      : "https://finopsexports.blob.core.usgovcloudapi.net"
                  }
                />
              </Field>
            )}

            {isS3 && (
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor={`${id}-path-style`}>
                    Path-style addressing
                  </Label>
                  <Hint>Most S3-compatible stores need this.</Hint>
                </div>
                <Switch
                  id={`${id}-path-style`}
                  checked={values.forcePathStyle}
                  onCheckedChange={(checked) =>
                    set({ forcePathStyle: checked })
                  }
                />
              </div>
            )}

            {assumeRole && (
              <>
                <Field
                  {...field("externalId", "External ID")}
                  hint="When the role's trust policy requires one."
                >
                  <Input {...text("externalId")} />
                </Field>
                <div className="space-y-1.5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field {...field("accessKeyId", "Source access key ID")}>
                      <Input {...text("accessKeyId")} />
                    </Field>
                    <Field
                      {...field("secretAccessKey", "Source secret access key")}
                    >
                      <SecretInput {...text("secretAccessKey")} />
                    </Field>
                  </div>
                  <Hint>
                    {keepsStored
                      ? "Credentials used to assume the role. Leave empty to keep the stored ones."
                      : "Credentials used to assume the role. Leave empty to use the server's own AWS identity."}
                  </Hint>
                </div>
              </>
            )}

            {usesSessionToken && (
              <Field
                {...field("sessionToken", "Session token")}
                hint="For temporary credentials."
              >
                <SecretInput {...text("sessionToken")} />
              </Field>
            )}
          </AdvancedSection>

          {failure && (
            <InlineNotice variant="error" ref={noticeRef}>
              <AlertTriangle />
              <InlineNoticeBody>
                <span className="font-medium">
                  {failure.connection
                    ? "Connection test failed"
                    : "Couldn't save"}
                </span>
                <InlineNoticeText className="break-words">
                  {failure.message}
                </InlineNoticeText>
              </InlineNoticeBody>
              {failure.connection && (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="ml-auto"
                  disabled={saving}
                  onClick={() => void submit(true)}
                >
                  Save anyway
                </Button>
              )}
            </InlineNotice>
          )}
        </DialogBody>
        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving
              ? "Testing connection…"
              : provider
                ? "Test and save"
                : "Test and add"}
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

// === internal ===

/** Optional fields that live under Advanced (secret ones only while edited). */
const ADVANCED_FIELDS = [
  "keyPrefix",
  "endpoint",
  "externalId",
  "sessionToken",
] as const satisfies (keyof BlobProviderFormValues)[];

function providerUsesAdvanced(provider: BlobProvider | null): boolean {
  const config = provider?.config;
  if (!config) return false;
  if (config.keyPrefix) return true;
  switch (config.type) {
    case "s3":
      return (
        !!config.endpoint ||
        config.forcePathStyle ||
        !!config.externalId ||
        (config.authMethod === "assume_role" && !!provider?.hasCredentials)
      );
    case "azure_blob":
      return !!config.endpoint;
    default:
      return false;
  }
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : hint ? (
        <Hint>{hint}</Hint>
      ) : null}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
