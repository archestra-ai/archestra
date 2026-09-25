"use client";

import type { OnMount } from "@monaco-editor/react";
import { useCallback } from "react";
import { Editor } from "@/components/editor";
import { QueryLoadError } from "@/components/query-load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { useBatteryPolicySource } from "@/lib/openappa-batteries.query";
import { batteryDisplayName } from "./battery-display-name";
import { focusPolicyLine } from "./policy-decorations";
import { POLICY_EDITOR_OPTIONS } from "./policy-editor-options";

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
    (editor) => {
      focusPolicyLine(editor, focusLine);
    },
    [focusLine],
  );

  if (source.isPending)
    return <Skeleton className="h-72 w-full rounded-t-none" />;
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
      className="overflow-hidden rounded-b-lg border bg-background"
    >
      <Editor
        height="min(50vh, 560px)"
        language="ini"
        value={source.data.content}
        onMount={onMount}
        options={{
          ...POLICY_EDITOR_OPTIONS,
          readOnly: true,
          ariaLabel: `${name} battery policy TOML`,
        }}
      />
    </section>
  );
}
