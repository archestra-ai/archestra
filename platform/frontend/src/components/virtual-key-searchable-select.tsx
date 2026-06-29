"use client";

import Image from "next/image";
import {
  type LlmProviderApiKeyResponse,
  PROVIDER_CONFIG,
} from "@/components/llm-provider-api-key-form";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";

export type VirtualKeyProviderApiKey = {
  provider: string;
  providerApiKeyId: string;
  providerApiKeyName: string;
};

export type VirtualKeyApiItem = {
  id: string;
  name: string;
  providerApiKeys: VirtualKeyProviderApiKey[];
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
  const providerApiKeys = option.providerApiKeys ?? [];

  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="flex shrink-0 gap-1">
        {providerApiKeys.map((pk) => {
          const config =
            PROVIDER_CONFIG[
              pk.provider as LlmProviderApiKeyResponse["provider"]
            ];
          if (!config?.icon) return null;
          return (
            <Image
              key={pk.providerApiKeyId}
              src={config.icon}
              alt={config.name}
              width={16}
              height={16}
              className="rounded dark:invert"
            />
          );
        })}
      </div>
      <div className="min-w-0 flex-1 flex flex-col">
        <span className="truncate">{option.name}</span>
        {providerApiKeys.length > 0 && (
          <span className="truncate text-xs text-muted-foreground">
            {providerApiKeys.map((pk) => pk.providerApiKeyName).join(", ")}
          </span>
        )}
      </div>
    </div>
  );
}

function VirtualKeySelectedValue({ option }: { option: VirtualKeyApiItem }) {
  const providerApiKeys = option.providerApiKeys ?? [];
  const firstProvider = providerApiKeys[0];
  const config = firstProvider
    ? PROVIDER_CONFIG[
        firstProvider.provider as LlmProviderApiKeyResponse["provider"]
      ]
    : null;

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
        searchText: `${key.name} ${key.providerApiKeys?.map((pk) => `${pk.provider} ${pk.providerApiKeyName}`).join(" ") ?? ""}`,
        content: <VirtualKeyOptionLabel option={key} />,
        selectedContent: <VirtualKeySelectedValue option={key} />,
      }))}
    />
  );
}
