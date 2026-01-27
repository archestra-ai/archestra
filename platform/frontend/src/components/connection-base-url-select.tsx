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

const { externalProxyUrls } = config.api;

interface ConnectionBaseUrlSelectProps {
  value: string;
  onChange: (value: string) => void;
  idPrefix: string;
}

export function ConnectionBaseUrlSelect({
  value,
  onChange,
  idPrefix,
}: ConnectionBaseUrlSelectProps) {
  // Build options: internal URL first, then external URLs
  const options = externalProxyUrls.map((url) => ({
    url,
    label: url,
  }));

  if (externalProxyUrls.length <= 1) {
    return null;
  }

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
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
