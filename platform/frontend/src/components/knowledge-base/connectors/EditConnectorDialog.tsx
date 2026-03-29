import React, { useState, useEffect } from "react";
import { ConnectorType } from "./ConnectorTypeSelector";
import { NotionConnectorFields } from "./NotionConnectorFields";
import type { ConnectorFormData } from "./CreateConnectorDialog";

interface EditConnectorDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: ConnectorFormData) => Promise<void>;
  /** Existing connector data to pre-populate the form */
  connector: {
    id: string;
    name: string;
    type: ConnectorType;
    config?: {
      databaseIds?: string[];
      pageIds?: string[];
      [key: string]: unknown;
    };
  } | null;
}

function joinList(items: string[] | undefined): string {
  return items ? items.join(", ") : "";
}

export const EditConnectorDialog: React.FC<EditConnectorDialogProps> = ({
  open,
  onClose,
  onSubmit,
  connector,
}) => {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Notion-specific
  const [notionFields, setNotionFields] = useState<{
    integrationToken?: string;
    databaseIds?: string;
    pageIds?: string;
  }>({});

  // Pre-populate from connector prop
  useEffect(() => {
    if (!connector) return;
    setName(connector.name);
    setError(null);

    if (connector.type === "notion") {
      setNotionFields({
        integrationToken: "",
        databaseIds: joinList(connector.config?.databaseIds),
        pageIds: joinList(connector.config?.pageIds),
      });
    }
  }, [connector]);

  const handleNotionFieldChange = (field: string, value: string) => {
    setNotionFields((prev) => ({ ...prev, [field]: value }));
  };

  const handleClose = () => {
    setError(null);
    onClose();
  };

  function parseCommaList(value: string | undefined): string[] | undefined {
    if (!value) return undefined;
    const items = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connector) return;
    setError(null);
    setSubmitting(true);

    try {
      const data: ConnectorFormData = {
        name: name.trim() || connector.type,
        type: connector.type,
      };

      if (connector.type === "notion") {
        if (notionFields.integrationToken) {
          data.integrationToken = notionFields.integrationToken;
        }
        data.databaseIds = parseCommaList(notionFields.databaseIds);
        data.pageIds = parseCommaList(notionFields.pageIds);
      }

      await onSubmit(data);
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open || !connector) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-connector-title"
    >
      <div className="relative w-full max-w-lg rounded-xl bg-white p-6 shadow-xl dark:bg-gray-900">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2
            id="edit-connector-title"
            className="text-lg font-semibold text-gray-900 dark:text-white"
          >
            Edit Connector
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Connector type badge */}
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium capitalize text-gray-700 dark:bg-gray-800 dark:text-gray-300">
              {connector.type}
            </span>
          </div>

          {/* Connector name */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor="edit-connector-name"
              className="text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Connector Name
            </label>
            <input
              id="edit-connector-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white disabled:opacity-50"
            />
          </div>

          {/* Connector-specific fields */}
          {connector.type === "notion" && (
            <>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Leave the Integration Token blank to keep the existing
                credential.
              </p>
              <NotionConnectorFields
                onChange={handleNotionFieldChange}
                values={notionFields}
                disabled={submitting}
              />
            </>
          )}

          {/* Error */}
          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={submitting}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
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
