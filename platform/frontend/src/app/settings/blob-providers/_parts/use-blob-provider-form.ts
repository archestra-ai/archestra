import {
  AZURE_BLOB_AUTH_METHOD_LABELS,
  type AzureBlobAuthMethod,
  type BlobProviderType,
  GCS_AUTH_METHOD_LABELS,
  type GcsAuthMethod,
  S3_AUTH_METHOD_LABELS,
  type S3AuthMethod,
} from "@archestra/shared";
import { useEffect, useId, useState } from "react";
import {
  type BlobProvider,
  type CreateBlobProviderBody,
  useCreateBlobProvider,
  useUpdateBlobProvider,
} from "@/lib/blob-provider.query";
import { getApiErrorInternalCode, getApiErrorMessage } from "@/lib/utils/api";

/**
 * State and behaviour of the blob provider create/edit form, shared by every
 * layout of it: values per provider type, validation, and a save that tests
 * the connection first. A failed test lands in `failure` (with
 * `connection: true`) and `submit(true)` saves anyway.
 */
export function useBlobProviderForm({
  open,
  provider,
  onSaved,
}: {
  open: boolean;
  /** The provider being edited; null creates one. */
  provider: BlobProvider | null;
  /** Called with the saved provider. */
  onSaved: (saved: BlobProvider) => void;
}) {
  const id = useId();
  const create = useCreateBlobProvider();
  const update = useUpdateBlobProvider();
  const [values, setValues] = useState<BlobProviderFormValues>(() =>
    toForm(provider),
  );
  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<{
    message: string;
    connection: boolean;
  } | null>(null);

  // A fresh form each time the dialog opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: provider is read when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setValues(toForm(provider));
    setSubmitted(false);
    setFailure(null);
  }, [open]);

  const set = (patch: Partial<BlobProviderFormValues>) => {
    setFailure(null);
    setValues((current) => ({ ...current, ...patch }));
  };
  const setType = (type: BlobProviderType) =>
    set({ type, authMethod: DEFAULT_AUTH[type] });
  /** Credentials for this auth method are stored and kept unless replaced. */
  const keepsStored =
    !!provider?.hasCredentials &&
    provider.config.type === values.type &&
    provider.config.authMethod === values.authMethod;
  const errors = validate(values, keepsStored);
  const errorFor = (name: keyof BlobProviderFormValues) =>
    submitted ? errors[name] : undefined;
  const saving = create.isPending || update.isPending;

  const submit = async (skipConnectionTest = false) => {
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    setFailure(null);
    const config = toConfig(values);
    const credentials = toCredentials(values);
    try {
      const saved = provider
        ? await update.mutateAsync({
            id: provider.id,
            body: {
              name: values.name,
              config,
              credentials,
              skipConnectionTest,
            },
          })
        : await create.mutateAsync({
            name: values.name,
            config,
            credentials,
            skipConnectionTest,
          });
      onSaved(saved);
    } catch (error) {
      setFailure({
        message: getApiErrorMessage(error),
        // The mutation throws an Error whose cause is the API error body.
        connection:
          getApiErrorInternalCode(
            error instanceof Error && error.cause ? error.cause : error,
          ) === "blob_provider_connection_failed",
      });
    }
  };

  /** Props for a text input bound to a field. */
  const input = (name: BlobProviderTextField) => ({
    id: `${id}-${name}`,
    value: values[name],
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => set({ [name]: event.target.value }),
    autoComplete: "off",
    "aria-invalid": !!errorFor(name),
  });

  return {
    /** Prefix for element ids, unique per dialog instance. */
    id,
    isEdit: !!provider,
    values,
    set,
    setType,
    input,
    errorFor,
    keepsStored,
    /** The secret fields the chosen auth method uses (empty: none). */
    secretFields: secretFields(values),
    saving,
    failure,
    submit,
  };
}

export const BLOB_PROVIDER_TYPES: BlobProviderType[] = [
  "s3",
  "gcs",
  "azure_blob",
];

/** One line on what each provider type covers. */
export const BLOB_PROVIDER_TYPE_HINTS: Record<BlobProviderType, string> = {
  s3: "Also MinIO, Cloudflare R2, Ceph and other S3-compatible stores.",
  gcs: "A Cloud Storage bucket.",
  azure_blob: "A container in a storage account.",
};

/** Auth method labels per provider type, in display order. */
export const BLOB_PROVIDER_AUTH_LABELS: Record<
  BlobProviderType,
  Record<string, string>
> = {
  s3: S3_AUTH_METHOD_LABELS,
  gcs: GCS_AUTH_METHOD_LABELS,
  azure_blob: AZURE_BLOB_AUTH_METHOD_LABELS,
};

/** What each auth method authenticates as, in a sentence. */
export const BLOB_PROVIDER_AUTH_HINTS: Record<
  BlobProviderType,
  Record<string, string>
> = {
  s3: {
    default_chain:
      "The server's own AWS identity: IRSA, EKS Pod Identity, an instance or task role, or environment variables.",
    access_key: "A static IAM access key.",
    assume_role:
      "Calls sts:AssumeRole into a role you grant on the bucket, e.g. in another account.",
  },
  gcs: {
    application_default:
      "The server's own Google identity: GKE Workload Identity, an attached service account, or GOOGLE_APPLICATION_CREDENTIALS.",
    service_account_key:
      "A JSON key of a service account with access to the bucket.",
  },
  azure_blob: {
    default_credential:
      "The server's own Azure identity: AKS Workload Identity, a managed identity, or environment variables. Needs Storage Blob Data Contributor.",
    service_principal:
      "A Microsoft Entra app registration with Storage Blob Data Contributor on the container.",
    account_key: "One of the storage account's access keys.",
    sas_token: "A shared access signature for the container.",
  },
};

export type BlobProviderFormValues = FormValues;
export type BlobProviderTextField = TextField;

// === internal ===

const DEFAULT_AUTH: Record<BlobProviderType, string> = {
  s3: "default_chain",
  gcs: "application_default",
  azure_blob: "default_credential",
};

type FormValues = {
  type: BlobProviderType;
  name: string;
  keyPrefix: string;
  authMethod: string;
  // S3 and GCS
  bucket: string;
  // S3
  region: string;
  forcePathStyle: boolean;
  roleArn: string;
  externalId: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  // S3 and Azure
  endpoint: string;
  // GCS
  serviceAccountKey: string;
  // Azure
  accountName: string;
  container: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  accountKey: string;
  sasToken: string;
};

type TextField = {
  [K in keyof FormValues]: FormValues[K] extends string ? K : never;
}[keyof FormValues];

function toForm(provider: BlobProvider | null): FormValues {
  const config = provider?.config;
  const base: FormValues = {
    type: config?.type ?? "s3",
    name: provider?.name ?? "",
    keyPrefix: config?.keyPrefix ?? "",
    authMethod: config?.authMethod ?? DEFAULT_AUTH.s3,
    bucket: "",
    region: "us-east-1",
    forcePathStyle: false,
    roleArn: "",
    externalId: "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    endpoint: "",
    serviceAccountKey: "",
    accountName: "",
    container: "",
    tenantId: "",
    clientId: "",
    clientSecret: "",
    accountKey: "",
    sasToken: "",
  };
  switch (config?.type) {
    case "s3":
      return {
        ...base,
        bucket: config.bucket,
        region: config.region,
        endpoint: config.endpoint ?? "",
        forcePathStyle: config.forcePathStyle,
        roleArn: config.roleArn ?? "",
        externalId: config.externalId ?? "",
      };
    case "gcs":
      return { ...base, bucket: config.bucket };
    case "azure_blob":
      return {
        ...base,
        accountName: config.accountName,
        container: config.container,
        endpoint: config.endpoint ?? "",
        tenantId: config.tenantId ?? "",
        clientId: config.clientId ?? "",
      };
    default:
      return base;
  }
}

function toConfig(values: FormValues): CreateBlobProviderBody["config"] {
  switch (values.type) {
    case "s3":
      return {
        type: "s3",
        bucket: values.bucket,
        region: values.region,
        keyPrefix: values.keyPrefix,
        endpoint: values.endpoint || null,
        forcePathStyle: values.forcePathStyle,
        authMethod: values.authMethod as S3AuthMethod,
        roleArn: values.roleArn || null,
        externalId: values.externalId || null,
      };
    case "gcs":
      return {
        type: "gcs",
        bucket: values.bucket,
        keyPrefix: values.keyPrefix,
        authMethod: values.authMethod as GcsAuthMethod,
      };
    case "azure_blob":
      return {
        type: "azure_blob",
        accountName: values.accountName,
        container: values.container,
        keyPrefix: values.keyPrefix,
        endpoint: values.endpoint || null,
        authMethod: values.authMethod as AzureBlobAuthMethod,
        tenantId: values.tenantId || null,
        clientId: values.clientId || null,
      };
  }
}

/** The secrets the form holds for its auth method; undefined keeps stored ones. */
function toCredentials(values: FormValues): Record<string, string> | undefined {
  const fields = secretFields(values);
  const entries = fields
    .map((name) => [name, values[name].trim()] as const)
    .filter(([, value]) => value);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function secretFields(values: FormValues): TextField[] {
  switch (values.type) {
    case "s3":
      return values.authMethod === "default_chain"
        ? []
        : ["accessKeyId", "secretAccessKey", "sessionToken"];
    case "gcs":
      return values.authMethod === "service_account_key"
        ? ["serviceAccountKey"]
        : [];
    case "azure_blob":
      return values.authMethod === "service_principal"
        ? ["clientSecret"]
        : values.authMethod === "account_key"
          ? ["accountKey"]
          : values.authMethod === "sas_token"
            ? ["sasToken"]
            : [];
  }
}

function validate(
  values: FormValues,
  keepsStored: boolean,
): Partial<Record<keyof FormValues, string>> {
  const errors: Partial<Record<keyof FormValues, string>> = {};
  const required = (name: TextField, label: string) => {
    if (!values[name].trim()) errors[name] = `${label} is required`;
  };
  required("name", "Name");
  if (values.endpoint && !/^https?:\/\/.+/.test(values.endpoint)) {
    errors.endpoint = "Must be an http(s) URL";
  }
  switch (values.type) {
    case "s3": {
      required("bucket", "Bucket");
      required("region", "Region");
      if (values.authMethod === "assume_role") required("roleArn", "Role ARN");
      const partial = !!values.accessKeyId !== !!values.secretAccessKey;
      if (partial || (values.authMethod === "access_key" && !keepsStored)) {
        required("accessKeyId", "Access key ID");
        required("secretAccessKey", "Secret access key");
      }
      break;
    }
    case "gcs":
      required("bucket", "Bucket");
      if (values.authMethod === "service_account_key" && !keepsStored) {
        required("serviceAccountKey", "Service account key");
      }
      break;
    case "azure_blob":
      required("accountName", "Storage account");
      required("container", "Container");
      if (values.authMethod === "service_principal") {
        required("tenantId", "Tenant ID");
        required("clientId", "Client ID");
      }
      if (!keepsStored) {
        if (values.authMethod === "service_principal") {
          required("clientSecret", "Client secret");
        } else if (values.authMethod === "account_key") {
          required("accountKey", "Account key");
        } else if (values.authMethod === "sas_token") {
          required("sasToken", "SAS token");
        }
      }
      break;
  }
  return errors;
}
