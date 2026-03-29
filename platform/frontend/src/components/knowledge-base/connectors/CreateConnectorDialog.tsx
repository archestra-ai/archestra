import React, { useState } from "react";
import { ConnectorTypeSelector, ConnectorType } from "./ConnectorTypeSelector";
import { NotionConnectorFields } from "./NotionConnectorFields";

interface CreateConnectorDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: ConnectorFormData) => Promise<void>;
}

export interface ConnectorFormData {
  name: string;
  type: ConnectorType;
  // Credentials
  integrationToken?: string;
  username?: string;
  apiToken?: string;
  accessToken?: string;
  password?: string;
  // Config
  instanceUrl?: string;
  databaseIds?: string[];
  pageIds?: string[];
  projectKeys?: string[];
  spaceKeys?: string[];
  repositories?: string[];
  projectIds?: string[];
  tables?: string[];
  syncIntervalMinutes?: number;
}

function parseCommaList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export const CreateConnectorDialog: React.FC<CreateConnectorDialogProps> = ({
  open,
  onClose,
  onSubmit,
}) => {
  const [step, setStep] = useState<"type" | "config">("type");
  const [connectorType, setConnectorType] = useState<ConnectorType | "">("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Notion-specific field values
  const [notionFields, setNotionFields] = useState<{
    integrationToken?: string;
    databaseIds?: string;
    pageIds?: string;
  }>({});

  const handleNotionFieldChange = (field: string, value: string) => {
    setNotionFields((prev) => ({ ...prev, [field]: value }));
  };

  const handleClose = () => {
    setStep("type");
    setConnectorType("");
    setName("");
    setNotionFields({});
    setError(null);
    onClose();
  };

  const handleNext = () => {
    if (!connectorType) return;
    setStep("config");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connectorType) return;
    setError(null);
    setSubmitting(true);

    try {
      const data: ConnectorFormData = {
        name: name.trim() || connectorType,
        type: connectorType as ConnectorType,
      };

      if (connectorType === "notion") {
        data.integrationToken = notionFields.integrationToken;
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

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-connector-title"
    >
      <div className="relative w-full max-w-lg rounded-xl bg-white p-6 shadow-xl dark:bg-gray-900">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2
            id="create-connector-title"
            className="text-lg font-semibold text-gray-900 dark:text-white"
          >
            {step === "type" ? "Choose Connector Type" : "Configure Connector"}
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

        {/* Step 1: Choose type */}
        {step === "type" && (
          <div className="flex flex-col gap-4">
            <ConnectorTypeSelector
              value={connectorType}
              onChange={setConnectorType}
              disabled={submitting}
            />
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleNext}
                disabled={!connectorType || submitting}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Next →
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Configure */}
        {step === "config" && connectorType && (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {/* Connector name */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="connector-name"
                className="text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Connector Name
              </label>
              <input
                id="connector-name"
                type="text"
                placeholder={`My ${connectorType} connector`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={submitting}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white disabled:opacity-50"
              />
            </div>

            {/* Connector-specific fields */}
            {connectorType === "notion" && (
              <NotionConnectorFields
                onChange={handleNotionFieldChange}
                values={notionFields}
                disabled={submitting}
              />
            )}

            {/* Error */}
            {error && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                {error}
              </p>
            )}

            {/* Actions */}
            <div className="flex justify-between">
              <button
                type="button"
                onClick={() => setStep("type")}
                disabled={submitting}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                ← Back
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? "Creating…" : "Create Connector"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default CreateConnectorDialog;
