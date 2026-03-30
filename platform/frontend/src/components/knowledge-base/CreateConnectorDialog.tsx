import React, { useState } from "react";
import NotionConfigFields from "./NotionConfigFields";
import { NotionIcon } from "./NotionIcon";

// ---------------------------------------------------------------------------
// Supported connector types
// ---------------------------------------------------------------------------

export type ConnectorType =
  | "jira"
  | "confluence"
  | "github"
  | "gitlab"
  | "servicenow"
  | "notion";

interface ConnectorTypeOption {
  value: ConnectorType;
  label: string;
  icon?: React.ReactNode;
  /** True when an instance URL is not required (cloud-only services) */
  cloudOnly?: boolean;
}

const CONNECTOR_OPTIONS: ConnectorTypeOption[] = [
  { value: "jira", label: "Jira" },
  { value: "confluence", label: "Confluence" },
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
  { value: "servicenow", label: "ServiceNow" },
  {
    value: "notion",
    label: "Notion",
    cloudOnly: true,
    icon: <NotionIcon className="h-5 w-5" />,
  },
];

// ---------------------------------------------------------------------------
// Form state types
// ---------------------------------------------------------------------------

interface CommonFields {
  name: string;
  type: ConnectorType;
}

interface NotionFields {
  integrationToken: string;
  databaseIds: string;
  pageIds: string;
}

// Generic credential fields used by non-Notion connectors
interface GenericFields {
  instanceUrl: string;
  username: string;
  apiToken: string;
}

type FormState = CommonFields & NotionFields & GenericFields;

// ---------------------------------------------------------------------------
// Dialog props
// ---------------------------------------------------------------------------

export interface CreateConnectorDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (config: Record<string, unknown>) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const CreateConnectorDialog: React.FC<CreateConnectorDialogProps> = ({
  open,
  onClose,
  onSubmit,
}) => {
  const [form, setForm] = useState<FormState>({
    name: "",
    type: "notion",
    // Notion-specific
    integrationToken: "",
    databaseIds: "",
    pageIds: "",
    // Generic
    instanceUrl: "",
    username: "",
    apiToken: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const selectedOption = CONNECTOR_OPTIONS.find((o) => o.value === form.type)!;

  function handleChange(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function buildConfig(): Record<string, unknown> {
    const base: Record<string, unknown> = {
      name: form.name,
      type: form.type,
    };

    if (form.type === "notion") {
      base.notion = {
        integrationToken: form.integrationToken.trim(),
        databaseIds: form.databaseIds
          ? form.databaseIds.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
        pageIds: form.pageIds
          ? form.pageIds.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
      };
    } else {
      // Generic connectors
      base.instanceUrl = form.instanceUrl.trim();
      base.username = form.username.trim();
      base.apiToken = form.apiToken.trim();
    }

    return base;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Basic client-side validation for Notion
    if (form.type === "notion" && !form.integrationToken.startsWith("secret_")) {
      setError('Integration Token must start with "secret_".');
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(buildConfig());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Add Knowledge Connector
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
          {/* Connector name */}
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => handleChange("name", e.target.value)}
              placeholder="My Notion Workspace"
              required
              disabled={submitting}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* Connector type selector */}
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700">
              Connector Type <span className="text-red-500">*</span>
            </label>
            <div className="grid grid-cols-3 gap-2">
              {CONNECTOR_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleChange("type", opt.value)}
                  disabled={submitting}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors
                    ${
                      form.type === opt.value
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                    }`}
                >
                  {opt.icon}
                  {opt.label}
                </button>
              ))}
            </div>
            {selectedOption.cloudOnly && (
              <p className="text-xs text-gray-500 mt-1">
                {selectedOption.label} is a cloud service — no instance URL
                required.
              </p>
            )}
          </div>

          {/* Connector-specific fields */}
          {form.type === "notion" ? (
            <NotionConfigFields
              integrationToken={form.integrationToken}
              databaseIds={form.databaseIds}
              pageIds={form.pageIds}
              onChange={handleChange}
              disabled={submitting}
            />
          ) : (
            /* Generic fields for other connectors */
            <div className="space-y-4">
              <div className="space-y-1">
                <label className="block text-sm font-medium text-gray-700">
                  Instance URL
                </label>
                <input
                  type="url"
                  value={form.instanceUrl}
                  onChange={(e) => handleChange("instanceUrl", e.target.value)}
                  placeholder="https://your-instance.atlassian.net"
                  disabled={submitting}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-sm font-medium text-gray-700">
                  Username / Email
                </label>
                <input
                  type="text"
                  value={form.username}
                  onChange={(e) => handleChange("username", e.target.value)}
                  placeholder="user@example.com"
                  disabled={submitting}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-sm font-medium text-gray-700">
                  API Token
                </label>
                <input
                  type="password"
                  value={form.apiToken}
                  onChange={(e) => handleChange("apiToken", e.target.value)}
                  placeholder="API token or password"
                  disabled={submitting}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !form.name}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? "Adding…" : "Add Connector"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateConnectorDialog;
