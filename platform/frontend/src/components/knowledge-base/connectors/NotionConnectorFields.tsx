import React from "react";

interface NotionConnectorFieldsProps {
  /** Called when any field value changes */
  onChange: (field: string, value: string) => void;
  /** Current field values */
  values?: {
    integrationToken?: string;
    databaseIds?: string;
    pageIds?: string;
  };
  /** Whether fields are disabled (e.g. while submitting) */
  disabled?: boolean;
}

/**
 * Form fields for configuring a Notion knowledge connector.
 *
 * Credentials:
 *   - Integration Token (required, starts with "secret_")
 *
 * Config (optional):
 *   - Database IDs (comma-separated)
 *   - Page IDs (comma-separated)
 */
export const NotionConnectorFields: React.FC<NotionConnectorFieldsProps> = ({
  onChange,
  values = {},
  disabled = false,
}) => {
  return (
    <div className="flex flex-col gap-4">
      {/* Integration Token */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor="notion-integration-token"
          className="text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Integration Token{" "}
          <span className="text-red-500" aria-hidden="true">
            *
          </span>
        </label>
        <input
          id="notion-integration-token"
          type="password"
          placeholder="secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          value={values.integrationToken ?? ""}
          onChange={(e) => onChange("integrationToken", e.target.value)}
          disabled={disabled}
          autoComplete="off"
          className="rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white disabled:opacity-50"
        />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Your Notion Internal Integration Token. Create one at{" "}
          <a
            href="https://www.notion.so/my-integrations"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-blue-600"
          >
            notion.so/my-integrations
          </a>
          . Must start with <code className="font-mono">secret_</code>.
        </p>
      </div>

      {/* Database IDs (optional) */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor="notion-database-ids"
          className="text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Database IDs{" "}
          <span className="text-xs font-normal text-gray-400">(optional)</span>
        </label>
        <input
          id="notion-database-ids"
          type="text"
          placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx, yyyyyyyy..."
          value={values.databaseIds ?? ""}
          onChange={(e) => onChange("databaseIds", e.target.value)}
          disabled={disabled}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white disabled:opacity-50"
        />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Comma-separated Notion database IDs to sync. Leave blank to sync the
          entire workspace.
        </p>
      </div>

      {/* Page IDs (optional) */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor="notion-page-ids"
          className="text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Page IDs{" "}
          <span className="text-xs font-normal text-gray-400">(optional)</span>
        </label>
        <input
          id="notion-page-ids"
          type="text"
          placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx, yyyyyyyy..."
          value={values.pageIds ?? ""}
          onChange={(e) => onChange("pageIds", e.target.value)}
          disabled={disabled}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white disabled:opacity-50"
        />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Comma-separated Notion page IDs to sync. Takes precedence over
          Database IDs when provided.
        </p>
      </div>
    </div>
  );
};

export default NotionConnectorFields;
