"use client";

import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import { SelectItem } from "@/components/ui/select";

export function LlmProviderOptionLabel({
  icon,
  name,
  subtext,
  showComingSoon = false,
  showGeminiVertexAiBadge = false,
  showBedrockIamBadge = false,
}: {
  icon: string;
  name: string;
  subtext?: string;
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
      <div className="flex flex-col">
        <div className="flex items-center gap-2">
          <span>{name}</span>
          {showComingSoon && (
            <Badge variant="outline" className="text-xs">
              Coming Soon
            </Badge>
          )}
          {showGeminiVertexAiBadge && (
            <Badge variant="secondary" className="text-xs">
              Vertex AI
            </Badge>
          )}
          {showBedrockIamBadge && (
            <Badge variant="secondary" className="text-xs">
              AWS IAM
            </Badge>
          )}
        </div>
        {subtext && (
          <span className="text-xs text-muted-foreground">{subtext}</span>
        )}
      </div>
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
    subtext?: string;
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
        subtext={option.subtext}
        showComingSoon={option.showComingSoon}
        showGeminiVertexAiBadge={option.showGeminiVertexAiBadge}
        showBedrockIamBadge={option.showBedrockIamBadge}
      />
    </SelectItem>
  ));
}
