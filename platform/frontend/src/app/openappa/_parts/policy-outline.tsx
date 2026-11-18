"use client";

import { ListTree, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useGuardrailsPolicy } from "@/lib/guardrails-policy.query";
import { useBatteryPolicySource } from "@/lib/openappa-batteries.query";
import { cn } from "@/lib/utils/tailwind";
import { parsePolicyRules } from "./policy-files";
import type { PolicyWorkspace } from "./use-policy-workspace";

/** The tool rules of the open file; choosing one reveals it in the editor. */
export function PolicyOutline({ workspace }: { workspace: PolicyWorkspace }) {
  const { active } = workspace;
  return (
    <aside
      aria-label="Rule outline"
      className="hidden w-52 shrink-0 flex-col border-l bg-muted/20 lg:flex"
    >
      {active.kind === "root" ? (
        <RootOutline workspace={workspace} />
      ) : (
        <IncludeOutline
          key={active.key}
          entry={active.entry ?? active.path}
          workspace={workspace}
        />
      )}
    </aside>
  );
}

function RootOutline({ workspace }: { workspace: PolicyWorkspace }) {
  const policy = useGuardrailsPolicy();
  return (
    <OutlineList
      workspace={workspace}
      content={policy.data?.content ?? null}
      isLoading={policy.isLoading}
    />
  );
}

function IncludeOutline({
  entry,
  workspace,
}: {
  entry: string;
  workspace: PolicyWorkspace;
}) {
  const source = useBatteryPolicySource(entry);
  return (
    <OutlineList
      workspace={workspace}
      content={source.data?.content ?? null}
      isLoading={source.isPending}
    />
  );
}

function OutlineList({
  workspace,
  content,
  isLoading,
}: {
  workspace: PolicyWorkspace;
  content: string | null;
  isLoading: boolean;
}) {
  const [filter, setFilter] = useState("");
  const rules = useMemo(() => parsePolicyRules(content ?? ""), [content]);
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? rules.filter((rule) => rule.name.toLowerCase().includes(needle))
    : rules;
  // The rule the focused line falls in: the last one starting at or before it.
  const focus = workspace.focusLine;
  const current = focus
    ? rules.reduce<number | null>(
        (found, rule) => (rule.line <= focus ? rule.line : found),
        null,
      )
    : null;

  return (
    <>
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b bg-muted px-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        <ListTree className="size-3 shrink-0" aria-hidden />
        <span>Rules</span>
        <span className="ml-auto font-mono font-normal tabular-nums">
          {needle ? `${shown.length}/${rules.length}` : rules.length}
        </span>
      </div>
      {rules.length > FILTER_FROM && (
        <div className="flex h-7 shrink-0 items-center gap-1.5 border-b px-2">
          <Search
            className="size-3 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter rules"
            aria-label="Filter rules"
            className="h-full w-full min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto py-0.5">
        {shown.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {isLoading
              ? "Loading rules"
              : needle
                ? "No rule matches"
                : "No tool rules in this file"}
          </p>
        ) : (
          shown.map((rule) => {
            const isCurrent = rule.line === current;
            return (
              <UnstyledButton
                key={rule.line}
                title={rule.name}
                aria-current={isCurrent ? "location" : undefined}
                onClick={() =>
                  workspace.open(workspace.active.entry, rule.line)
                }
                className={cn(
                  "relative flex h-6 w-full items-center gap-2 pl-2.5 pr-2 text-left text-xs outline-none",
                  isCurrent
                    ? "bg-accent font-medium text-accent-foreground before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary"
                    : "text-foreground/80 hover:bg-accent/60 focus-visible:bg-accent/60",
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                  {rule.name}
                </span>
                <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
                  {rule.line}
                </span>
              </UnstyledButton>
            );
          })
        )}
      </div>
    </>
  );
}

/** A short list is read at a glance; a filter only earns its row past this. */
const FILTER_FROM = 8;
