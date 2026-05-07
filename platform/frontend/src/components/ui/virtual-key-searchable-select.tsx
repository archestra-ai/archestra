"use client";

import Image from "next/image";
import {
  type LlmProviderApiKeyResponse,
  PROVIDER_CONFIG,
} from "@/components/llm-provider-api-key-form";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";

export type VirtualKeySelectOption = {
  id: string;
  name: string;
  parentKeyProvider?: string | null;
  parentKeyName?: string | null;
};

export type VirtualKeyApiItem = {
  id: string;
  name: string;
  parentKeyProvider?: string | null;
  parentKeyName?: string | null;
};

export interface VirtualKeySearchableSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  virtualKeys: VirtualKeyApiItem[];
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
  disabled?: boolean;
  emptyMessage?: string;
}

function VirtualKeyOptionLabel({ option }: { option: VirtualKeyApiItem }) {
  const provider = option.parentKeyProvider as
    | LlmProviderApiKeyResponse["provider"]
    | null;
  const config = provider ? PROVIDER_CONFIG[provider] : null;

  return (
    <div className="flex min-w-0 items-center gap-2">
      {config?.icon && (
        <Image
          src={config.icon}
          alt={config.name}
          width={16}
          height={16}
          className="shrink-0 rounded dark:invert"
        />
      )}
      <div className="min-w-0 flex-1 flex flex-col">
        <span className="truncate">{option.name}</span>
        {option.parentKeyName && (
          <span className="truncate text-xs text-muted-foreground">
            {option.parentKeyName}
          </span>
        )}
      </div>
    </div>
  );
}

function VirtualKeySelectedValue({ option }: { option: VirtualKeyApiItem }) {
  const provider = option.parentKeyProvider as
    | LlmProviderApiKeyResponse["provider"]
    | null;
  const config = provider ? PROVIDER_CONFIG[provider] : null;

  return (
    <div className="flex min-w-0 items-center gap-2">
      {config?.icon && (
        <Image
          src={config.icon}
          alt={config.name}
          width={16}
          height={16}
          className="shrink-0 rounded dark:invert"
        />
      )}
      <span className="truncate">{option.name}</span>
    </div>
  );
}

export function VirtualKeySearchableSelect({
  value,
  onValueChange,
  virtualKeys,
  placeholder = "Select virtual key",
  searchPlaceholder = "Search virtual keys...",
  className,
  disabled = false,
  emptyMessage = "No matching virtual keys found.",
}: VirtualKeySearchableSelectProps) {
  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      disabled={disabled}
      className={cn("w-full", className)}
      emptyMessage={emptyMessage}
      items={virtualKeys.map((key) => ({
        value: key.id,
        label: key.name,
        searchText: `${key.name} ${key.parentKeyProvider ?? ""} ${key.parentKeyName ?? ""}`,
        content: <VirtualKeyOptionLabel option={key} />,
        selectedContent: <VirtualKeySelectedValue option={key} />,
      }))}
    />
  );
}
