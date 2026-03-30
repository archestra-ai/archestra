import React from "react";

interface NotionConfigFieldsProps {
  integrationToken: string;
  databaseIds: string;
  pageIds: string;
  onChange: (field: string, value: string) => void;
  disabled?: boolean;
}

/**
 * Config fields rendered inside the create/edit connector dialogs when
 * "Notion" is selected as the connector type.
 *
 * - integrationToken  — required; Notion Integration Token (secret_...)
 * - databaseIds       — optional; comma-separated Notion database IDs
 * - pageIds           — optional; comma-separated Notion page IDs
 */
const NotionConfigFields: React.FC<NotionConfigFieldsProps> = ({
  integrationToken,
  databaseIds,
  pageIds,
  onChange,
  disabled = false,
}) => {
  return (
    <div className="space-y-4">
      {/* Integration Token */}
      <div className="space-y-1">
        <label
          htmlFor="notion-integration-token"
          className="block text-sm font-medium text-gray-700"
        >
          Integration Token <span className="text-red-500">*</span>
        </label>
        <input
          id="notion-integration-token"
          type="password"
          value={integrationToken}
          onChange={(e) => onChange("integrationToken", e.target.value)}
          placeholder="secret_..."
          disabled={disabled}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-50"
          autoComplete="off"
        />
        <p className="text-xs text-gray-500">
          Create an Internal Integration in{" "}
          <a
            href="https://www.notion.so/my-integrations"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            Notion Settings → Integrations
          </a>{" "}
          and paste the token here.
        </p>
      </div>

      {/* Database IDs */}
      <div className="space-y-1">
        <label
          htmlFor="notion-database-ids"
          className="block text-sm font-medium text-gray-700"
        >
          Database IDs{" "}
          <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <input
          id="notion-database-ids"
          type="text"
          value={databaseIds}
          onChange={(e) => onChange("databaseIds", e.target.value)}
          placeholder="abc123, def456"
          disabled={disabled}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-50"
        />
        <p className="text-xs text-gray-500">
          Comma-separated Notion database IDs. Leave blank to sync all accessible
          pages.
        </p>
      </div>

      {/* Page IDs */}
      <div className="space-y-1">
        <label
          htmlFor="notion-page-ids"
          className="block text-sm font-medium text-gray-700"
        >
          Page IDs{" "}
          <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <input
          id="notion-page-ids"
          type="text"
          value={pageIds}
          onChange={(e) => onChange("pageIds", e.target.value)}
          placeholder="page-id-1, page-id-2"
          disabled={disabled}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-50"
        />
        <p className="text-xs text-gray-500">
          Comma-separated Notion page IDs. When set, only these pages are synced
          (overrides Database IDs and full-workspace sync).
        </p>
      </div>
    </div>
  );
};

export default NotionConfigFields;
