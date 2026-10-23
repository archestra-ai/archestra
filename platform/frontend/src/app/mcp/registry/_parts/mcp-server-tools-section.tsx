"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCatalogTools } from "@/lib/mcp/internal-mcp-catalog.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * The tools a server gives agents, with a pointer to the Inspector for trying
 * one. Hidden when the server has none.
 */
export function McpServerToolsSection({ catalogId }: { catalogId: string }) {
  const { data: tools, isLoading } = useCatalogTools(catalogId);
  const [expanded, setExpanded] = useState(false);
  const inspectorHref = useInspectorHref();

  if (!isLoading && !tools?.length) return null;

  const all = tools ?? [];
  const shown = expanded ? all : all.slice(0, TOOL_PREVIEW);

  return (
    <SettingsSection
      title={
        <span className="inline-flex items-baseline gap-2">
          Tools
          {!isLoading && (
            <span className="text-sm font-normal tabular-nums text-muted-foreground">
              {all.length}
            </span>
          )}
        </span>
      }
      description={
        <>
          What agents can call on this server. To try one yourself, open the{" "}
          <Link
            href={inspectorHref}
            className="text-foreground underline decoration-muted-foreground/50 underline-offset-4 transition-colors hover:decoration-foreground"
          >
            Inspector
          </Link>
          .
        </>
      }
    >
      {isLoading ? (
        <Skeleton className="h-56 w-full rounded-md" />
      ) : (
        <div className="overflow-hidden rounded-md border">
          <ul className="grid gap-px bg-border sm:grid-cols-2">
            {shown.map((tool, index) => (
              <li
                key={tool.id}
                className={cn(
                  "min-w-0 bg-background px-4 py-3",
                  // An odd last tool spans both columns, so no hole is left.
                  shown.length % 2 === 1 &&
                    index === shown.length - 1 &&
                    "sm:col-span-2",
                )}
              >
                <div className="truncate font-mono text-[13px] text-foreground">
                  {shortToolName(tool.name)}
                </div>
                <div
                  className="mt-0.5 truncate text-xs text-muted-foreground"
                  title={tool.description ?? undefined}
                >
                  {tool.description || "No description"}
                </div>
              </li>
            ))}
          </ul>
          {all.length > TOOL_PREVIEW && (
            <div className="border-t px-2 py-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setExpanded((value) => !value)}
                className="text-muted-foreground"
              >
                {expanded ? "Show fewer" : `Show all ${all.length} tools`}
              </Button>
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

// ===

const TOOL_PREVIEW = 10;

/** The same page on its Inspector tab, keeping every other query param. */
function useInspectorHref() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const next = new URLSearchParams(searchParams?.toString());
  next.set("tab", "inspector");
  return `${pathname}?${next.toString()}`;
}

function shortToolName(name: string) {
  const index = name.lastIndexOf("__");
  return index > 0 ? name.slice(index + 2) : name;
}
