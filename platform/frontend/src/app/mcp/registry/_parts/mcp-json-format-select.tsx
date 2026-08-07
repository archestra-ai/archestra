"use client";

import { CLAUDE_PATH } from "@/app/connection/clients";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { McpJsonExportFormat } from "./mcp-config-import";

/**
 * Format picker for the Import & export panel: every option is a shape the import
 * parser recognizes, so what you copy out can always be pasted back in.
 * Options follow the house select idiom (LlmProviderOptionLabel): a brand
 * icon, the format's name, and a muted subtext. A format the current config
 * cannot be VALIDLY exported to is disabled with the reason as its subtext
 * (see canExportRegistryJson / canExportServersJson).
 */
export function McpJsonFormatSelect({
  value,
  onValueChange,
  disabledReasons,
}: {
  value: McpJsonExportFormat;
  onValueChange: (value: McpJsonExportFormat) => void;
  disabledReasons: Partial<Record<McpJsonExportFormat, string>>;
}) {
  const selected = FORMAT_OPTIONS.find((option) => option.value === value);
  return (
    <Select
      value={value}
      onValueChange={(next) => onValueChange(next as McpJsonExportFormat)}
    >
      <SelectTrigger
        size="sm"
        aria-label="JSON format"
        className="h-8 gap-1.5 border-0 bg-transparent px-2 shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
      >
        {/* Controlled value: the trigger shows the icon and name — subtexts
            belong to the open list. */}
        <SelectValue>
          <span className="flex items-center gap-2 text-xs font-medium">
            {selected?.icon}
            <span>{selected?.name}</span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {FORMAT_OPTIONS.map((option) => {
          const disabledReason = disabledReasons[option.value] ?? null;
          return (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={disabledReason !== null}
            >
              <div className="flex items-center gap-2">
                {option.icon}
                <div className="flex flex-col">
                  <span>{option.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {disabledReason ?? option.subtext}
                  </span>
                </div>
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

// Icons are decorative — the format name always sits next to them.
const FORMAT_OPTIONS: {
  value: McpJsonExportFormat;
  name: string;
  subtext: string;
  icon: React.ReactNode;
}[] = [
  {
    value: "mcpServers",
    name: "Claude Code",
    subtext: "the mcpServers block — also Claude Desktop, Cursor",
    icon: (
      <svg
        viewBox="0 0 24 24"
        width={16}
        height={16}
        className="shrink-0"
        aria-hidden="true"
      >
        <path d={CLAUDE_PATH} fill="#D97757" />
      </svg>
    ),
  },
  {
    value: "servers",
    name: "VS Code / Copilot",
    subtext: "the servers block",
    icon: (
      // The official colored mark — no dark:invert, it reads on both themes.
      // Plain <img> like ModelSelectorLogo: a fixed 16px decorative icon
      // gains nothing from next/image optimization.
      <img
        src="/model-logos/vscode.svg"
        alt=""
        width={16}
        height={16}
        className="shrink-0"
      />
    ),
  },
  {
    value: "registry",
    name: "MCP Registry",
    subtext: "the official server.json schema",
    icon: (
      <img
        src="/model-logos/mcp.svg"
        alt=""
        width={16}
        height={16}
        className="shrink-0 dark:invert"
      />
    ),
  },
];
