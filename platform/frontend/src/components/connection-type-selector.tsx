"use client";

import { CodeText } from "@/components/code-text";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import config from "@/lib/config";

const { externalProxyUrls, internalProxyUrl } = config.api;

// The selected URL value - either the internal URL or one of the external URLs
export type ConnectionUrl = string;

interface ConnectionTypeSelectorProps {
  value: ConnectionUrl;
  onChange: (value: ConnectionUrl) => void;
  gatewayName: string;
  idPrefix: string;
}

export function ConnectionTypeSelector({
  value,
  onChange,
  gatewayName,
  idPrefix,
}: ConnectionTypeSelectorProps) {
  // Build options: internal URL first, then external URLs
  const options = [
    { url: internalProxyUrl, label: "Internal", isInternal: true },
    ...externalProxyUrls.map((url) => ({
      url,
      label: url,
      isInternal: false,
    })),
  ];

  // Determine if external URLs are configured
  const hasExternalUrls = externalProxyUrls.length > 0;

  return (
    <div className="space-y-2">
      <Label
        htmlFor={`${idPrefix}-connection-url`}
        className="text-sm font-medium"
      >
        Connection Base URL
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={`${idPrefix}-connection-url`} className="w-full">
          <SelectValue placeholder="Select a connection URL">
            {value && <CodeText className="text-xs">{value}</CodeText>}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.url} value={option.url}>
              <div className="flex flex-col gap-0.5 items-start">
                <CodeText className="text-xs">{option.url}</CodeText>
                <span className="text-[10px] text-muted-foreground">
                  {option.isInternal
                    ? `Internal URL for in-cluster communication`
                    : `External URL for connecting from outside the cluster`}
                </span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <p className="text-sm text-muted-foreground">
        The URL is configurable via{" "}
        <CodeText className="text-xs">ARCHESTRA_API_BASE_URL</CodeText>{" "}
        environment variable. See{" "}
        <a
          href="https://archestra.ai/docs/platform-deployment#environment-variables"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-500"
        >
          here
        </a>{" "}
        for more details.
      </p>
    </div>
  );
}
