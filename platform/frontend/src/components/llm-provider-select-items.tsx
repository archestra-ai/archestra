"use client";

import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import { SelectItem } from "@/components/ui/select";

export function LlmProviderOptionLabel({
  icon,
  name,
  showComingSoon = false,
  showGeminiVertexAiBadge = false,
  showBedrockIamBadge = false,
}: {
  icon: string;
  name: string;
  showComingSoon?: boolean;
  showGeminiVertexAiBadge?: boolean;
  showBedrockIamBadge?: boolean;
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
      {showBedrockIamBadge && (
        <Badge variant="secondary" className="ml-2 text-xs">
          AWS IAM
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
    showBedrockIamBadge?: boolean;
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
        showBedrockIamBadge={option.showBedrockIamBadge}
      />
    </SelectItem>
  ));
}
