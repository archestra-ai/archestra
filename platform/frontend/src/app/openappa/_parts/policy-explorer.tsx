"use client";

import {
  Loader2,
  LockKeyhole,
  Play,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import {
  FILE_ROW_ACTION_CLASS,
  FileExplorer,
  type FileExplorerSection,
} from "@/components/file-workspace/file-explorer";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import { batteriesHref } from "./battery-status";
import { useOpenAppaChatLaunch } from "./openappa-chat-button";
import {
  INCLUDED_FILES_HINT,
  POLICY_FILE_KIND,
  POLICY_FILE_KINDS,
  PolicyStatusDot,
  policyFileIcon,
} from "./policy-file-kind";
import type { PolicyFile } from "./policy-files";
import { VALIDATION_STATUS_LOOK } from "./policy-validation-pane";
import type { PolicyWorkspace } from "./use-policy-workspace";

/**
 * The policy's files in the workspace explorer: one section per kind, so the
 * organization policy, the batteries and the repository's files never read
 * as one another, with the files' real folders inside.
 */
export function PolicyExplorer({
  workspace,
  overlay = false,
}: {
  workspace: PolicyWorkspace;
  /** Fills a panel laid over the editor on a small screen, where the column beside it has no room. */
  overlay?: boolean;
}) {
  // A validation is written by the policy agent: New validation opens the
  // chat on that request.
  const newValidation = useOpenAppaChatLaunch({
    subject: { kind: "prompt", promptKey: "writeValidations" },
  });
  const suite = workspace.validations;
  const { attentionCount } = workspace;
  const sections = useMemo(
    () =>
      POLICY_FILE_KINDS.flatMap((kind): FileExplorerSection<PolicyFile>[] => {
        const files = workspace.files.filter((file) => file.kind === kind);
        // The validations keep their section while it is empty: it is where
        // the first one is added.
        if (files.length === 0 && !(kind === "validation" && suite)) return [];
        return [
          {
            id: kind,
            title: workspace.scoped
              ? "MCP server rules"
              : POLICY_FILE_KIND[kind].section,
            titleHint:
              kind === "repository" && !workspace.scoped
                ? INCLUDED_FILES_HINT
                : undefined,
            count: kind === "root" ? undefined : files.length,
            files,
            empty:
              kind === "validation" ? (
                <p>
                  No validations yet. A validation replays tool calls against
                  the policy and checks each decision.
                </p>
              ) : undefined,
            actions:
              kind === "validation" && suite ? (
                <ValidationSectionActions
                  failed={
                    files.filter((file) => file.validation?.status === "failed")
                      .length
                  }
                  cannotRun={
                    files.filter(
                      (file) => file.validation?.status === "cannot_run",
                    ).length
                  }
                  running={suite.runningAll}
                  canRun={suite.runnable && files.length > 0}
                  onRunAll={() => suite.runAll()}
                  newHref={suite.canWrite ? (newValidation.href ?? null) : null}
                />
              ) : kind === "battery" && attentionCount > 0 ? (
                // Every included battery with a problem is in the Needs attention group.
                <Link
                  href={batteriesHref("attention")}
                  aria-label={`${attentionCount} not enforced`}
                  title={`${attentionCount} not enforced`}
                  className="flex items-center gap-0.5 rounded-sm bg-amber-500/15 px-1 font-mono font-medium normal-case tracking-normal text-amber-700 underline-offset-2 hover:underline dark:text-amber-400"
                >
                  <TriangleAlert className="size-2.5" aria-hidden />
                  <span>{attentionCount}</span>
                </Link>
              ) : undefined,
          },
        ];
      }),
    [
      workspace.files,
      workspace.scoped,
      suite,
      attentionCount,
      newValidation.href,
    ],
  );

  return (
    <FileExplorer
      label="Policy files"
      overlay={overlay}
      sections={sections}
      activeKey={workspace.view === "source" ? workspace.active.key : null}
      onOpen={(file) => workspace.open(file.entry)}
      fileIcon={(file) => {
        const Icon = policyFileIcon(file);
        return (
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              file.disabled
                ? "text-muted-foreground/60"
                : POLICY_FILE_KIND[file.kind].iconClass,
            )}
            aria-hidden
          />
        );
      }}
      fileTrailing={(file) => (
        <>
          {file.severity && (
            <>
              <PolicyStatusDot severity={file.severity} className="ml-auto" />
              <span className="sr-only">{file.statusLabel}</span>
            </>
          )}
          {file.validation && (
            <>
              <span
                aria-hidden
                className={cn(
                  "ml-auto size-1.5 shrink-0 rounded-full",
                  VALIDATION_STATUS_LOOK[file.validation.status].dot,
                )}
              />
              <span className="sr-only">
                {VALIDATION_STATUS_LOOK[file.validation.status].label}
              </span>
            </>
          )}
          {file.canEdit === false && (
            <>
              <LockKeyhole
                className="ml-auto size-3 shrink-0 text-muted-foreground/70"
                aria-hidden
              />
              <span className="sr-only">Read-only</span>
            </>
          )}
        </>
      )}
      // Every row has a tooltip, so a row keeps its element when the
      // sync settings arrive and turn a file into an MCP server's rules.
      fileTooltip={(file) =>
        file.kind === "root" ? (
          <span>Organization policy</span>
        ) : file.kind === "battery" ? (
          <span className="flex items-center gap-1.5">
            <span className="font-medium">{file.label}</span>
            <span>{file.statusLabel}</span>
          </span>
        ) : file.validation ? (
          <span className="flex items-center gap-1.5">
            <span className="font-medium">{file.validation.title}</span>
            <span>{VALIDATION_STATUS_LOOK[file.validation.status].label}</span>
          </span>
        ) : (
          <span>{repositoryFileTip(file)}</span>
        )
      }
    />
  );
}

/** What the validations add to their section's header: how they stand, run all, new. */
function ValidationSectionActions({
  failed,
  cannotRun,
  running,
  canRun,
  onRunAll,
  newHref,
}: {
  failed: number;
  cannotRun: number;
  running: boolean;
  canRun: boolean;
  onRunAll: () => void;
  /** The chat, opened on a request for a new validation; null when it cannot be asked. */
  newHref: string | null;
}) {
  const button = FILE_ROW_ACTION_CLASS;
  return (
    <>
      {!running && failed > 0 && (
        <span
          title={`${failed} failed`}
          className="flex items-center gap-0.5 rounded-sm bg-destructive/10 px-1 font-mono font-medium normal-case tracking-normal text-destructive"
        >
          <X className="size-2.5" aria-hidden />
          <span>{failed}</span>
          <span className="sr-only">failed</span>
        </span>
      )}
      {!running && cannotRun > 0 && (
        <span
          title={`${cannotRun} cannot run`}
          className="flex items-center gap-0.5 rounded-sm bg-amber-500/15 px-1 font-mono font-medium normal-case tracking-normal text-amber-700 dark:text-amber-400"
        >
          <TriangleAlert className="size-2.5" aria-hidden />
          <span>{cannotRun}</span>
          <span className="sr-only">cannot run</span>
        </span>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            aria-label="Run all validations"
            disabled={!canRun}
            onClick={onRunAll}
            className={button}
          >
            {running ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <Play className="size-3" aria-hidden />
            )}
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent side="right">Run all validations</TooltipContent>
      </Tooltip>
      {newHref && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link href={newHref} aria-label="New validation" className={button}>
              <Plus className="size-3" aria-hidden />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-48">
            New validation: ask the policy agent in chat
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

function repositoryFileTip(file: PolicyFile): string {
  if (!file.mcpServerRules) return "Included from your repository";
  const servers = (file.servers ?? []).map((server) => server.name).join(", ");
  return `MCP server rules${servers ? `: ${servers}` : ""}${
    file.canEdit === false ? " · read-only" : ""
  }`;
}
