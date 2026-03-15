"use client";

import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function LlmProviderOptionLabel({
  icon,
  name,
  showComingSoon = false,
  showGeminiVertexAiBadge = false,
}: {
  icon: string;
  name: string;
  showComingSoon?: boolean;
  showGeminiVertexAiBadge?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Image
        src={icon}
        alt={name}
        width={16}
        height={16}
        className="rounded dark:invert"
      />
      <span>{name}</span>
      {showComingSoon && (
        <Badge variant="outline" className="ml-2 text-xs">
          Coming Soon
        </Badge>
      )}
      {showGeminiVertexAiBadge && (
        <Badge variant="secondary" className="ml-2 text-xs">
          Vertex AI
        </Badge>
      )}
    </div>
  );
}

export function LlmProviderApiKeyOptionLabel({
  icon,
  providerName,
  keyName,
  secondaryLabel,
}: {
  icon: string;
  providerName: string;
  keyName: string;
  secondaryLabel?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Image
        src={icon}
        alt={providerName}
        width={16}
        height={16}
        className="rounded dark:invert"
      />
      <span>{keyName}</span>
      {secondaryLabel && (
        <Badge variant="outline" className="text-xs">
          {secondaryLabel}
        </Badge>
      )}
    </div>
  );
}

export function LlmProviderSelectItems({
  options,
}: {
  options: {
    value: string;
    icon: string;
    name: string;
    disabled?: boolean;
    showComingSoon?: boolean;
    showGeminiVertexAiBadge?: boolean;
  }[];
}) {
  return options.map((option) => (
    <SelectItem
      key={option.value}
      value={option.value}
      disabled={option.disabled}
    >
      <LlmProviderOptionLabel
        icon={option.icon}
        name={option.name}
        showComingSoon={option.showComingSoon}
        showGeminiVertexAiBadge={option.showGeminiVertexAiBadge}
      />
    </SelectItem>
  ));
}

export function LlmProviderApiKeySelectItems({
  options,
}: {
  options: {
    value: string;
    icon: string;
    providerName: string;
    keyName: string;
    secondaryLabel?: string;
  }[];
}) {
  return options.map((option) => (
    <SelectItem key={option.value} value={option.value}>
      <LlmProviderApiKeyOptionLabel
        icon={option.icon}
        providerName={option.providerName}
        keyName={option.keyName}
        secondaryLabel={option.secondaryLabel}
      />
    </SelectItem>
  ));
}

export function LlmProviderApiKeyFilterSelect({
  value,
  onValueChange,
  options,
  allLabel = "All provider API keys",
  className = "w-full sm:w-[280px]",
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: {
    value: string;
    icon: string;
    providerName: string;
    keyName: string;
    secondaryLabel?: string;
  }[];
  allLabel?: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className={className}>
        <SelectValue placeholder={allLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{allLabel}</SelectItem>
        <LlmProviderApiKeySelectItems options={options} />
      </SelectContent>
    </Select>
  );
}
