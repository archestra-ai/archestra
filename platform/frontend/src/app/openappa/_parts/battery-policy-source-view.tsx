"use client";

import type { OnMount } from "@monaco-editor/react";
import { FileCode2 } from "lucide-react";
import { useCallback } from "react";
import { Editor } from "@/components/editor";
import { QueryLoadError } from "@/components/query-load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { useBatteryPolicySource } from "@/lib/openappa-batteries.query";
import { batteryDisplayName } from "./battery-display-name";
import { focusPolicyLine } from "./policy-decorations";

/** Read-only source for the exact battery include linked from a tool rule. */
export function BatteryPolicySourceView({
  entry,
  focusLine,
}: {
  entry: string;
  focusLine?: number;
}) {
  const source = useBatteryPolicySource(entry);
  const onMount = useCallback<OnMount>(
    (editor) => focusPolicyLine(editor, focusLine),
    [focusLine],
  );

  if (source.isPending) return <Skeleton className="h-72 w-full" />;
  if (source.isError || !source.data)
    return (
      <QueryLoadError
        title="Could not load battery policy source"
        onRetry={() => source.refetch()}
      />
    );

  const name = batteryDisplayName(source.data.name);

  return (
    <section
      aria-label={`${name} battery policy source`}
      className="overflow-hidden rounded-lg border bg-background"
    >
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">
            <span>{`${name} battery policy`}</span>
            {focusLine && (
              <span className="text-muted-foreground">{` · line ${focusLine}`}</span>
            )}
          </h2>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {source.data.entry}
          </p>
        </div>
      </div>
      <Editor
        height="min(50vh, 560px)"
        language="ini"
        value={source.data.content}
        onMount={onMount}
        options={{
          readOnly: true,
          ariaLabel: `${name} battery policy TOML`,
          minimap: { enabled: false },
          fontSize: 14,
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          wordWrap: "on",
          padding: { top: 16, bottom: 16 },
          automaticLayout: true,
        }}
      />
    </section>
  );
}
