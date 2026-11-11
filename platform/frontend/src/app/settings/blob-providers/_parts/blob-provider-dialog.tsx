"use client";

import {
  BLOB_PROVIDER_TYPE_LABELS,
  S3_AUTH_METHOD_LABELS,
  type S3AuthMethod,
} from "@archestra/shared";
import { useEffect, useId, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  type BlobProvider,
  type CreateBlobProviderBody,
  useCreateBlobProvider,
  useUpdateBlobProvider,
} from "@/lib/blob-provider.query";

/** Create a blob provider, or edit one. Credentials are write-only. */
export function BlobProviderDialog({
  open,
  onOpenChange,
  provider,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The provider being edited; null creates one. */
  provider: BlobProvider | null;
}) {
  const id = useId();
  const create = useCreateBlobProvider();
  const update = useUpdateBlobProvider();
  const [values, setValues] = useState<FormValues>(() => toForm(provider));
  const [submitted, setSubmitted] = useState(false);

  // A fresh form each time the dialog opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: provider is read when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setValues(toForm(provider));
    setSubmitted(false);
  }, [open]);

  const set = (patch: Partial<FormValues>) =>
    setValues((current) => ({ ...current, ...patch }));
  const errors = validate(values, provider);
  const shown = (field: keyof FormValues) =>
    submitted ? errors[field] : undefined;
  const saving = create.isPending || update.isPending;
  const usesKeys = values.authMethod !== "default_chain";

  const submit = async () => {
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const config: CreateBlobProviderBody["config"] = {
      type: "s3",
      bucket: values.bucket,
      region: values.region,
      keyPrefix: values.keyPrefix,
      endpoint: values.endpoint || null,
      forcePathStyle: values.forcePathStyle,
      authMethod: values.authMethod,
      roleArn: values.authMethod === "assume_role" ? values.roleArn : null,
      externalId:
        values.authMethod === "assume_role" ? values.externalId || null : null,
    };
    const credentials =
      usesKeys && values.accessKeyId && values.secretAccessKey
        ? {
            accessKeyId: values.accessKeyId,
            secretAccessKey: values.secretAccessKey,
            sessionToken: values.sessionToken || undefined,
          }
        : undefined;
    try {
      if (provider) {
        await update.mutateAsync({
          id: provider.id,
          body: { name: values.name, config, credentials },
        });
      } else {
        await create.mutateAsync({ name: values.name, config, credentials });
      }
      onOpenChange(false);
    } catch {
      // The query layer has shown the error; the dialog stays open.
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={provider ? "Edit blob provider" : "Add blob provider"}
      description={BLOB_PROVIDER_TYPE_LABELS.s3}
      size="medium"
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DialogBody className="space-y-4">
          <Field id={`${id}-name`} label="Name" error={shown("name")}>
            <Input
              id={`${id}-name`}
              value={values.name}
              onChange={(event) => set({ name: event.target.value })}
              placeholder="finops-bucket"
              autoComplete="off"
              autoFocus
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`${id}-bucket`} label="Bucket" error={shown("bucket")}>
              <Input
                id={`${id}-bucket`}
                value={values.bucket}
                onChange={(event) => set({ bucket: event.target.value })}
                placeholder="my-finops-bucket"
                autoComplete="off"
              />
            </Field>
            <Field id={`${id}-region`} label="Region" error={shown("region")}>
              <Input
                id={`${id}-region`}
                value={values.region}
                onChange={(event) => set({ region: event.target.value })}
                placeholder="us-east-1"
                autoComplete="off"
              />
            </Field>
          </div>
          <Field
            id={`${id}-prefix`}
            label="Key prefix"
            hint="Optional. Every object is written under this prefix."
          >
            <Input
              id={`${id}-prefix`}
              value={values.keyPrefix}
              onChange={(event) => set({ keyPrefix: event.target.value })}
              placeholder="archestra"
              autoComplete="off"
            />
          </Field>
          <Field
            id={`${id}-endpoint`}
            label="Custom endpoint"
            hint="Only for S3-compatible stores such as MinIO, Cloudflare R2 or Ceph."
            error={shown("endpoint")}
          >
            <Input
              id={`${id}-endpoint`}
              value={values.endpoint}
              onChange={(event) => set({ endpoint: event.target.value })}
              placeholder="https://s3.example.com"
              autoComplete="off"
            />
          </Field>
          <div className="flex items-center gap-2">
            <Switch
              id={`${id}-path-style`}
              checked={values.forcePathStyle}
              onCheckedChange={(checked) => set({ forcePathStyle: checked })}
            />
            <Label htmlFor={`${id}-path-style`} className="font-normal">
              Path-style addressing (most S3-compatible stores need this)
            </Label>
          </div>
          <Field id={`${id}-auth`} label="Authentication">
            <Select
              value={values.authMethod}
              onValueChange={(value) =>
                set({ authMethod: value as S3AuthMethod })
              }
            >
              <SelectTrigger id={`${id}-auth`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTH_METHODS.map((method) => (
                  <SelectItem key={method} value={method}>
                    {S3_AUTH_METHOD_LABELS[method]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {values.authMethod === "assume_role" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id={`${id}-role`}
                label="Role ARN"
                error={shown("roleArn")}
              >
                <Input
                  id={`${id}-role`}
                  value={values.roleArn}
                  onChange={(event) => set({ roleArn: event.target.value })}
                  placeholder="arn:aws:iam::123456789012:role/archestra-export"
                  autoComplete="off"
                />
              </Field>
              <Field
                id={`${id}-external-id`}
                label="External ID"
                hint="Optional, when the role's trust policy requires one."
              >
                <Input
                  id={`${id}-external-id`}
                  value={values.externalId}
                  onChange={(event) => set({ externalId: event.target.value })}
                  autoComplete="off"
                />
              </Field>
            </div>
          )}
          {usesKeys && (
            <div className="space-y-4 rounded-md border p-4">
              <p className="text-sm text-muted-foreground">
                {values.authMethod === "assume_role"
                  ? "Optional source credentials for assuming the role. Leave empty to use the default credential chain."
                  : "Stored in the secrets manager and never shown again."}
                {provider?.hasCredentials && (
                  <span> Leave empty to keep the stored credentials.</span>
                )}
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id={`${id}-key-id`}
                  label="Access key ID"
                  error={shown("accessKeyId")}
                >
                  <Input
                    id={`${id}-key-id`}
                    value={values.accessKeyId}
                    onChange={(event) =>
                      set({ accessKeyId: event.target.value })
                    }
                    autoComplete="off"
                  />
                </Field>
                <Field
                  id={`${id}-secret`}
                  label="Secret access key"
                  error={shown("secretAccessKey")}
                >
                  <Input
                    id={`${id}-secret`}
                    type="password"
                    value={values.secretAccessKey}
                    onChange={(event) =>
                      set({ secretAccessKey: event.target.value })
                    }
                    autoComplete="new-password"
                  />
                </Field>
              </div>
              <Field
                id={`${id}-session`}
                label="Session token"
                hint="Optional, for temporary credentials."
              >
                <Input
                  id={`${id}-session`}
                  type="password"
                  value={values.sessionToken}
                  onChange={(event) =>
                    set({ sessionToken: event.target.value })
                  }
                  autoComplete="new-password"
                />
              </Field>
            </div>
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
            {saving ? "Saving…" : provider ? "Save changes" : "Add provider"}
          </Button>
        </DialogStickyFooter>
      </form>
    </FormDialog>
  );
}

// === internal ===

const AUTH_METHODS: S3AuthMethod[] = [
  "default_chain",
  "access_key",
  "assume_role",
];

type FormValues = {
  name: string;
  bucket: string;
  region: string;
  keyPrefix: string;
  endpoint: string;
  forcePathStyle: boolean;
  authMethod: S3AuthMethod;
  roleArn: string;
  externalId: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};

function toForm(provider: BlobProvider | null): FormValues {
  const config = provider?.config;
  return {
    name: provider?.name ?? "",
    bucket: config?.bucket ?? "",
    region: config?.region ?? "us-east-1",
    keyPrefix: config?.keyPrefix ?? "",
    endpoint: config?.endpoint ?? "",
    forcePathStyle: config?.forcePathStyle ?? false,
    authMethod: config?.authMethod ?? "default_chain",
    roleArn: config?.roleArn ?? "",
    externalId: config?.externalId ?? "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
  };
}

function validate(
  values: FormValues,
  provider: BlobProvider | null,
): Partial<Record<keyof FormValues, string>> {
  const errors: Partial<Record<keyof FormValues, string>> = {};
  if (!values.name.trim()) errors.name = "Name is required";
  if (!values.bucket.trim()) errors.bucket = "Bucket is required";
  if (!values.region.trim()) errors.region = "Region is required";
  if (values.endpoint && !/^https?:\/\/.+/.test(values.endpoint)) {
    errors.endpoint = "Must be an http(s) URL";
  }
  if (values.authMethod === "assume_role" && !values.roleArn.trim()) {
    errors.roleArn = "Role ARN is required";
  }
  const keepsStored = provider?.hasCredentials ?? false;
  const partialKeys = !!values.accessKeyId !== !!values.secretAccessKey;
  if (partialKeys) {
    if (!values.accessKeyId) errors.accessKeyId = "Access key ID is required";
    if (!values.secretAccessKey) {
      errors.secretAccessKey = "Secret access key is required";
    }
  }
  if (
    values.authMethod === "access_key" &&
    !keepsStored &&
    !values.accessKeyId &&
    !values.secretAccessKey
  ) {
    errors.accessKeyId = "Access key ID is required";
    errors.secretAccessKey = "Secret access key is required";
  }
  return errors;
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
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
