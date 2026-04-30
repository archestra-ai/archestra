"use client";

import type { archestraApiTypes } from "@shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ConnectionBaseUrl = NonNullable<
  archestraApiTypes.GetOrganizationResponses["200"]["connectionBaseUrls"]
>[number];

interface ConnectionUrlStepProps {
  /** All env-configured external proxy URLs in stable order. */
  candidateUrls: readonly string[];
  /** Admin-curated metadata keyed by URL. Empty/missing entries fall back. */
  metadata: readonly ConnectionBaseUrl[] | null | undefined;
  /** Currently selected URL (controlled). */
  value: string;
  onChange: (url: string) => void;
  /** Disable the selector until a client is picked. */
  disabled?: boolean;
}

/**
 * Standalone step on /connection that lets the user pick the connection base
 * URL once. Shows the admin-curated description so users know which endpoint
 * to use. Replaces the per-panel selector previously embedded in the MCP /
 * Proxy / A2A instruction blocks.
 */
export function ConnectionUrlStep({
  candidateUrls,
  metadata,
  value,
  onChange,
  disabled = false,
}: ConnectionUrlStepProps) {
  const metaByUrl = new Map((metadata ?? []).map((m) => [m.url, m] as const));
  const items = candidateUrls.map((url) => ({
    url,
    description: metaByUrl.get(url)?.description ?? "",
  }));

  if (items.length === 0) return null;
  if (items.length === 1) return null;

  const selected = items.find((i) => i.url === value) ?? items[0];

  return (
    <section className="border-b pb-5">
      <h3 className="pb-4 text-[17px] font-bold tracking-tight text-foreground">
        Select an endpoint
      </h3>

      <Select value={selected.url} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger
          disabled={disabled}
          className="h-12 w-full bg-white text-sm dark:bg-background [&_svg:not([class*=size-])]:size-5"
        >
          <SelectValue>
            <div className="flex min-w-0 flex-1 items-center gap-3 text-left">
              <code className="shrink-0 font-mono text-sm">{selected.url}</code>
              {selected.description && (
                <span className="min-w-0 truncate text-sm text-muted-foreground">
                  {selected.description}
                </span>
              )}
            </div>
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="min-w-[var(--radix-select-trigger-width)]">
          {items.map((item) => (
            <SelectItem
              key={item.url}
              value={item.url}
              className="py-2.5 pl-3 pr-9"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <code className="shrink-0 font-mono text-sm">{item.url}</code>
                {item.description && (
                  <span className="min-w-0 truncate text-sm text-muted-foreground">
                    {item.description}
                  </span>
                )}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  );
}
