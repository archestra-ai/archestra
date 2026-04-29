"use client";

import type { archestraApiTypes } from "@shared";
import { CodeText } from "@/components/code-text";
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
  /** Hide entirely when only one URL is configured AND no description exists. */
  hideWhenSingleAndUnannotated?: boolean;
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
  hideWhenSingleAndUnannotated = false,
}: ConnectionUrlStepProps) {
  const metaByUrl = new Map((metadata ?? []).map((m) => [m.url, m] as const));
  const items = candidateUrls.map((url) => ({
    url,
    description: metaByUrl.get(url)?.description ?? "",
  }));

  if (items.length === 0) return null;

  const selected = items.find((i) => i.url === value) ?? items[0];

  if (
    items.length === 1 &&
    hideWhenSingleAndUnannotated &&
    !selected.description
  ) {
    return null;
  }

  return (
    <section className="border-b pb-5">
      <h3 className="pb-4 text-[19px] font-bold tracking-tight text-foreground">
        Select an endpoint
      </h3>

      {items.length > 1 ? (
        <Select value={selected.url} onValueChange={onChange}>
          <SelectTrigger className="h-12 w-full text-sm [&_svg:not([class*=size-])]:size-5">
            <SelectValue>
              <div className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <CodeText className="shrink-0 text-sm">{selected.url}</CodeText>
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
                  <CodeText className="shrink-0 text-sm">{item.url}</CodeText>
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
      ) : (
        <div className="flex h-12 items-center gap-3 rounded-md border bg-muted/30 px-3">
          <CodeText className="shrink-0 text-sm">{selected.url}</CodeText>
          {selected.description && (
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {selected.description}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
