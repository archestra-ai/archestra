import React, { useState, useEffect } from "react";
import NotionConfigFields from "./NotionConfigFields";
import { NotionIcon } from "./NotionIcon";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectorType =
  | "jira"
  | "confluence"
  | "github"
  | "gitlab"
  | "servicenow"
  | "notion";

export interface ConnectorRecord {
  id: string;
  name: string;
  type: ConnectorType;
  config: Record<string, unknown>;
}

export interface EditConnectorDialogProps {
  open: boolean;
  connector: ConnectorRecord | null;
  onClose: () => void;
  onSubmit: (id: string, config: Record<string, unknown>) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helper — derive initial form state from an existing connector record
// ---------------------------------------------------------------------------

function deriveFormState(connector: ConnectorRecord) {
  const base = {
    name: connector.name,
    // Generic fields
    instanceUrl: (connector.config.instanceUrl as string) ?? "",
    username: (connector.config.username as string) ?? "",
    apiToken: (connector.config.apiToken as string) ?? "",
    // Notion-specific
    integrationToken: "",
    databaseIds: "",
    pageIds: "",
  };

  if (connector.type === "notion") {
    const notion = connector.config.notion as Record<string, unknown> | undefined;
    base.integrationToken = (notion?.integrationToken as string) ?? "";
    base.databaseIds = Array.isArray(notion?.databaseIds)
      ? (notion!.databaseIds as string[]).join(", ")
      : "";
    base.pageIds = Array.isArray(notion?.pageIds)
      ? (notion!.pageIds as string[]).join(", ")
      : "";
  }

  return base;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const EditConnectorDialog: React.FC<EditConnectorDialogProps> = ({
  open,
  connector,
  onClose,
  onSubmit,
}) => {
  const [form, setForm] = useState(() =>
    connector
      ? deriveFormState(connector)
      : {
          name: "",
          instanceUrl: "",
          username: "",
          apiToken: "",
          integrationToken: "",
          databaseIds: "",
          pageIds: "",
        }
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when connector changes
  useEffect(() => {
    if (connector) setForm(deriveFormState(connector));
  }, [connector]);

  if (!open || !connector) return null;

  function handleChange(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function buildConfig(): Record<string, unknown> {
    const base: Record<string, unknown> = { name: form.name };

    if (connector!.type === "notion") {
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
      base.instanceUrl = form.instanceUrl.trim();
      base.username = form.username.trim();
      base.apiToken = form.apiToken.trim();
    }

    return base;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (
      connector!.type === "notion" &&
      !form.integrationToken.startsWith("secret_")
    ) {
      setError('Integration Token must start with "secret_".');
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(connector!.id, buildConfig());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred.");
    } finally {
      setSubmitting(false);
    }
  }

  const isNotion = connector.type === "notion";

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
          <div className="flex items-center gap-2">
            {isNotion && <NotionIcon className="h-5 w-5 text-gray-700" />}
            <h2 className="text-lg font-semibold text-gray-900">
              Edit Connector
            </h2>
          </div>
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
          {/* Name */}
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => handleChange("name", e.target.value)}
              required
              disabled={submitting}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* Connector-type badge */}
          <div className="flex items-center gap-2 rounded-md bg-gray-50 border border-gray-200 px-3 py-2">
            {isNotion && <NotionIcon className="h-4 w-4 text-gray-600" />}
            <span className="text-sm text-gray-600 capitalize">
              {connector.type}
            </span>
            <span className="ml-auto text-xs text-gray-400">
              Type cannot be changed
            </span>
          </div>

          {/* Connector-specific config fields */}
          {isNotion ? (
            <NotionConfigFields
              integrationToken={form.integrationToken}
              databaseIds={form.databaseIds}
              pageIds={form.pageIds}
              onChange={handleChange}
              disabled={submitting}
            />
          ) : (
            <div className="space-y-4">
              <div className="space-y-1">
                <label className="block text-sm font-medium text-gray-700">
                  Instance URL
                </label>
                <input
                  type="url"
                  value={form.instanceUrl}
                  onChange={(e) => handleChange("instanceUrl", e.target.value)}
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
              {submitting ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default EditConnectorDialog;
