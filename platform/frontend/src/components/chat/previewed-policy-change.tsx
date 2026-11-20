"use client";

import type { UIMessage } from "@ai-sdk/react";
import type { ArchestraToolShortName } from "@archestra/shared";
import { createContext, type ReactNode, useContext } from "react";
import { OpenAppaPolicyArguments } from "./openappa-policy-change";
import {
  parsePolicyChange,
  parsePolicyOutput,
} from "./openappa-policy-change.utils";

/** A completed preview: its result, and the arguments it was called with. */
export type PreviewedChange = { output: unknown; input: unknown };

const NONE: ReadonlyMap<string, PreviewedChange> = new Map();
const PreviewedChangesContext = createContext(NONE);

export function PreviewedChangesProvider({
  value,
  children,
}: {
  value: ReadonlyMap<string, PreviewedChange>;
  children: ReactNode;
}) {
  return (
    <PreviewedChangesContext.Provider value={value}>
      {children}
    </PreviewedChangesContext.Provider>
  );
}

/**
 * The preview of the very file a call proposes, if the conversation holds
 * one: the same server, the same commit it was read at, the same content.
 */
export function usePreviewedChange(
  toolCallId: string | undefined,
): PreviewedChange | null {
  const previews = useContext(PreviewedChangesContext);
  return (toolCallId && previews.get(toolCallId)) || null;
}

/**
 * For each call that proposes a server's rules, the completed preview of the
 * very same file earlier in the conversation, keyed by the proposing call.
 * The diff of a change is shown in one place, its preview's card, whether or
 * not a pull request follows. A proposal of a previewed file therefore
 * points at that preview and prints neither the diff nor the raw file a
 * second time; one whose file was never previewed has no entry here and
 * shows what it sends.
 */
export function collectPreviewedChanges(
  messages: UIMessage[],
  getToolShortName: (name: string) => ArchestraToolShortName | null,
): ReadonlyMap<string, PreviewedChange> {
  const previews = new Map<string, PreviewedChange>();
  const result = new Map<string, PreviewedChange>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (!("toolCallId" in part)) continue;
      let name =
        part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
      let args: unknown = part.input;
      if (getToolShortName(name) === "run_tool") {
        const wrapped = part.input as
          | { tool_name?: unknown; tool_args?: unknown }
          | undefined;
        if (typeof wrapped?.tool_name !== "string") continue;
        name = wrapped.tool_name;
        args = wrapped.tool_args;
      }
      // run_tool also takes a built-in tool's bare short name.
      const shortName = getToolShortName(name) ?? name;
      if (
        shortName !== "preview_guardrails_server_rules_change" &&
        shortName !== "propose_guardrails_server_rules_change"
      )
        continue;
      const key = fileKey(args);
      if (!key) continue;
      if (shortName === "propose_guardrails_server_rules_change") {
        const previewed = previews.get(key);
        if (previewed) result.set(part.toolCallId, previewed);
      } else if (
        part.state === "output-available" &&
        showsAsDiff(part.output, args)
      ) {
        previews.set(key, { output: part.output, input: args });
      }
    }
  }
  return result.size ? result : NONE;
}

/**
 * Whether a preview's card shows the change as a diff: a result that reads
 * as a valid preview, with a diff that fits the file. Anything else (an
 * error text, a diff that cannot be undone) leaves no diff on screen, so a
 * proposal of the same file is not said to be "previewed above".
 */
function showsAsDiff(output: unknown, args: unknown): boolean {
  const parsed = parsePolicyOutput(output);
  return (
    !!parsed &&
    parsed.valid !== false &&
    parsePolicyChange(output, false, args) !== null
  );
}

/**
 * A proposal of a previewed file, in its card: the reviewers' summary and
 * the file it names, with the call's arguments closed below. The diff is
 * the preview's to show.
 */
export function PreviewedChangeReview({
  previewed,
  input,
}: {
  previewed: PreviewedChange;
  input: unknown;
}) {
  const summary = summaryOf(input);
  const path = parsePolicyOutput(previewed.output)?.path;
  return (
    <>
      <div className="space-y-1 px-3 pt-3 text-sm">
        {summary ? <p>{summary}</p> : null}
        <p className="text-muted-foreground">
          <span>The change previewed above</span>
          {typeof path === "string" ? (
            <>
              <span>, to </span>
              <span className="font-mono text-xs">{path}</span>
            </>
          ) : null}
          <span>.</span>
        </p>
      </div>
      <OpenAppaPolicyArguments
        input={input as Parameters<typeof OpenAppaPolicyArguments>[0]["input"]}
      />
    </>
  );
}

/** What approving a proposal does, for the approval row. */
export function proposalApprovalText(previewed: PreviewedChange): string {
  return parsePolicyOutput(previewed.output)?.autoMerge === true
    ? "Approving opens a pull request with the change previewed above on the policy repository. It merges by itself once its checks pass."
    : "Approving opens a pull request with the change previewed above on the policy repository. Nothing applies until it is merged.";
}

function fileKey(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const { mcpServerId, expectedCommit, content } = args as Record<
    string,
    unknown
  >;
  return typeof mcpServerId === "string" &&
    typeof expectedCommit === "string" &&
    typeof content === "string"
    ? `${mcpServerId}\n${expectedCommit}\n${content}`
    : null;
}

function summaryOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const args = input as { summary?: unknown; tool_args?: unknown };
  if (typeof args.summary === "string") return args.summary;
  return summaryOf(args.tool_args);
}
