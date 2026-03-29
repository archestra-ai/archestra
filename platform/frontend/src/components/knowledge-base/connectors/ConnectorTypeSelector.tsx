import React from "react";
import { NotionIcon } from "../../icons/NotionIcon";

export type ConnectorType =
  | "jira"
  | "confluence"
  | "github"
  | "gitlab"
  | "servicenow"
  | "notion";

interface ConnectorTypeOption {
  type: ConnectorType;
  label: string;
  icon: React.ReactNode;
  description: string;
}

const CONNECTOR_OPTIONS: ConnectorTypeOption[] = [
  {
    type: "jira",
    label: "Jira",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={20}
        height={20}
        viewBox="0 0 32 32"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M15.973 0C9.573 0 4.373 5.2 4.373 11.6c0 4.56 2.627 8.507 6.453 10.453l5.147 2.773 5.147-2.773C24.947 20.107 27.573 16.16 27.573 11.6 27.573 5.2 22.373 0 15.973 0zm0 17.067c-3.013 0-5.467-2.453-5.467-5.467s2.453-5.467 5.467-5.467 5.467 2.453 5.467 5.467-2.453 5.467-5.467 5.467z" />
      </svg>
    ),
    description: "Sync Jira issues and projects",
  },
  {
    type: "confluence",
    label: "Confluence",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={20}
        height={20}
        viewBox="0 0 32 32"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M1.387 21.693c-.32.507-.693 1.12-.96 1.547a.96.96 0 00.32 1.333l5.6 3.467a.96.96 0 001.387-.32c.24-.4.587-.96.96-1.547 2.613-4.16 5.28-3.653 10.027-1.28l5.547 2.72a.96.96 0 001.28-.48l2.773-6.027a.96.96 0 00-.48-1.28l-5.653-2.773C12.827 13.347 6.107 13.493 1.387 21.693zM30.613 10.307c.32-.507.693-1.12.96-1.547a.96.96 0 00-.32-1.333l-5.6-3.467a.96.96 0 00-1.387.32c-.24.4-.587.96-.96 1.547-2.613 4.16-5.28 3.653-10.027 1.28L7.733 4.387a.96.96 0 00-1.28.48L3.68 10.893a.96.96 0 00.48 1.28l5.653 2.773c9.173 4.48 15.893 4.333 20.8-4.64z" />
      </svg>
    ),
    description: "Sync Confluence pages and spaces",
  },
  {
    type: "github",
    label: "GitHub",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={20}
        height={20}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
      </svg>
    ),
    description: "Sync GitHub repositories and wikis",
  },
  {
    type: "gitlab",
    label: "GitLab",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={20}
        height={20}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 00-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 00-.867 0L1.386 9.45.044 13.587a.924.924 0 00.331 1.023L12 23.054l11.625-8.443a.924.924 0 00.33-1.024z" />
      </svg>
    ),
    description: "Sync GitLab repositories and wikis",
  },
  {
    type: "servicenow",
    label: "ServiceNow",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={20}
        height={20}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path
          fill="#fff"
          d="M7 12a5 5 0 0110 0H7z"
        />
      </svg>
    ),
    description: "Sync ServiceNow knowledge articles",
  },
  {
    type: "notion",
    label: "Notion",
    icon: <NotionIcon size={20} />,
    description: "Sync Notion pages and databases",
  },
];

interface ConnectorTypeSelectorProps {
  value: ConnectorType | "";
  onChange: (type: ConnectorType) => void;
  disabled?: boolean;
}

export const ConnectorTypeSelector: React.FC<ConnectorTypeSelectorProps> = ({
  value,
  onChange,
  disabled = false,
}) => {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {CONNECTOR_OPTIONS.map((option) => {
        const isSelected = value === option.type;
        return (
          <button
            key={option.type}
            type="button"
            onClick={() => onChange(option.type)}
            disabled={disabled}
            aria-pressed={isSelected}
            className={[
              "flex flex-col items-center gap-2 rounded-lg border p-3 text-center transition-colors",
              isSelected
                ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                : "border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700",
              disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
            ].join(" ")}
          >
            <span className="flex h-8 w-8 items-center justify-center">
              {option.icon}
            </span>
            <span className="text-xs font-medium">{option.label}</span>
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {option.description}
            </span>
          </button>
        );
      })}
    </div>
  );
};

export default ConnectorTypeSelector;
