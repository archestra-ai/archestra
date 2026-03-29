"use client";

import { NotionIcon } from "@/components/icons/NotionIcon";
import { CONNECTOR_LABELS } from "@archestra/shared/knowledge-base";

export type ConnectorType = (typeof CONNECTOR_LABELS)[number];

interface ConnectorOption {
  type: ConnectorType;
  label: string;
  description: string;
  icon: React.ReactNode;
}

const CONNECTOR_OPTIONS: ConnectorOption[] = [
  {
    type: "notion",
    label: "Notion",
    description: "Sync pages and databases from your Notion workspace.",
    icon: <NotionIcon className="h-6 w-6" />,
  },
];

interface ConnectorTypeSelectorProps {
  onSelect: (type: ConnectorType) => void;
}

export function ConnectorTypeSelector({ onSelect }: ConnectorTypeSelectorProps) {
  return (
    <div className="grid gap-3">
      {CONNECTOR_OPTIONS.map((option) => (
        <button
          key={option.type}
          type="button"
          onClick={() => onSelect(option.type)}
          className="flex items-center gap-4 rounded-lg border border-border p-4 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="shrink-0">{option.icon}</span>
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{option.label}</span>
            <span className="text-sm text-muted-foreground">
              {option.description}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
