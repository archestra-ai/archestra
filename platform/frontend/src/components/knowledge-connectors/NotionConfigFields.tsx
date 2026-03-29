import React from "react";

interface NotionConfigFieldsProps {
  integrationToken: string;
  databaseIds: string;
  pageIds: string;
  onChange: (field: string, value: string) => void;
  disabled?: boolean;
}

/**
 * Form fields for configuring a Notion knowledge connector.
 *
 * - integrationToken: Notion Internal Integration Token (secret_...)
 * - databaseIds: comma-separated list of Notion database IDs (optional)
 * - pageIds: comma-separated list of Notion page IDs (optional)
 */
export function NotionConfigFields({
  integrationToken,
  databaseIds,
  pageIds,
  onChange,
  disabled = false,
}: NotionConfigFieldsProps) {
  return (
    <div className="space-y-4">
      {/* Integration Token */}
      <div className="space-y-1">
        <label
          htmlFor="notion-integration-token"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Integration Token <span className="text-red-500">*</span>
        </label>
        <input
          id="notion-integration-token"
          type="password"
          placeholder="secret_..."
          value={integrationToken}
          disabled={disabled}
          onChange={(e) => onChange("integrationToken", e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Your Notion Internal Integration Token starting with{" "}
          <code className="rounded bg-gray-100 px-1 dark:bg-gray-700">secret_</code>. Create one
          at{" "}
          <a
            href="https://www.notion.so/my-integrations"
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-600 underline hover:text-indigo-800 dark:text-indigo-400"
          >
            notion.so/my-integrations
          </a>
          .
        </p>
      </div>

      {/* Database IDs */}
      <div className="space-y-1">
        <label
          htmlFor="notion-database-ids"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Database IDs{" "}
          <span className="text-xs font-normal text-gray-400">(optional)</span>
        </label>
        <input
          id="notion-database-ids"
          type="text"
          placeholder="abc123, def456, ..."
          value={databaseIds}
          disabled={disabled}
          onChange={(e) => onChange("databaseIds", e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Comma-separated Notion database IDs to sync. Leave blank to sync the entire workspace.
        </p>
      </div>

      {/* Page IDs */}
      <div className="space-y-1">
        <label
          htmlFor="notion-page-ids"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Page IDs{" "}
          <span className="text-xs font-normal text-gray-400">(optional)</span>
        </label>
        <input
          id="notion-page-ids"
          type="text"
          placeholder="abc123, def456, ..."
          value={pageIds}
          disabled={disabled}
          onChange={(e) => onChange("pageIds", e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Comma-separated Notion page IDs to sync specifically. If provided, only these pages are
          synced (takes precedence over Database IDs and full-workspace sync).
        </p>
      </div>
    </div>
  );
}

export default NotionConfigFields;
