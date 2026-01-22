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

interface ConnectionBaseUrlProps {
  value: ConnectionUrl;
  onChange: (value: ConnectionUrl) => void;
  idPrefix: string;
}

export function ConnectionBaseUrl({
  value,
  onChange,
  idPrefix,
}: ConnectionBaseUrlProps) {
  // Build options: internal URL first, then external URLs
  const options = externalProxyUrls.map((url) => ({
    url,
    label: url,
  }));

  const staticUrl =
    externalProxyUrls.length === 1 ? externalProxyUrls[0] : internalProxyUrl;

  const selectOrStaticExternalUrl =
    options.length > 1 ? (
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
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : (
      <div className="my-2">
        <CodeText className="text-xs">{staticUrl}</CodeText>
      </div>
    );

  return (
    <div className="space-y-2">
      <Label
        htmlFor={`${idPrefix}-connection-url`}
        className="text-sm font-medium"
      >
        Connection Base URL
      </Label>
      {selectOrStaticExternalUrl}
      <p className="text-sm text-muted-foreground">
        The URL{externalProxyUrls.length > 1 ? "s" : ""}{" "}
        {externalProxyUrls.length > 1 ? "are" : "is"} configurable via{" "}
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
