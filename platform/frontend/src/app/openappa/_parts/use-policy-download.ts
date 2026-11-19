"use client";

import { useQueryClient } from "@tanstack/react-query";
import type {
  ArchiveFile,
  WorkspaceDownload,
} from "@/components/file-workspace/download-zip";
import { guardrailsPolicyQuery } from "@/lib/guardrails-policy.query";
import {
  batteryPolicySourceQuery,
  effectivePolicyQuery,
} from "@/lib/openappa-batteries.query";
import type { PolicyFile } from "./policy-files";
import type { PolicyWorkspace } from "./use-policy-workspace";

/**
 * Every file of the policy for the bar's download button: the root at its
 * repository path, each battery and repository file it includes, the
 * validations, and the composed policy the runtime enforces. A reader of MCP
 * servers' rules gets their rules files and nothing else. Files are fetched
 * on click, from the same queries the editor reads them with.
 */
export function usePolicyDownload(
  workspace: PolicyWorkspace,
): WorkspaceDownload | null {
  const queryClient = useQueryClient();
  if (workspace.isPending) return null;
  const { files, scoped, validations } = workspace;
  return {
    name: scoped ? "mcp-server-rules" : "openappa-policy",
    files: async () => {
      const sources = await Promise.all(
        files.map(async (file): Promise<ArchiveFile | null> => {
          // An unavailable battery has no source to read; validations
          // arrive with their content below.
          if (file.disabled || file.kind === "validation") return null;
          if (file.kind === "root") {
            const policy = await queryClient.fetchQuery(guardrailsPolicyQuery);
            return policy ? { path: file.path, content: policy.content } : null;
          }
          const source = await queryClient.fetchQuery(
            batteryPolicySourceQuery(file.entry ?? file.path, {
              serverRules: scoped,
            }),
          );
          return { path: archivePath(file), content: source.content };
        }),
      );
      const effective = scoped
        ? null
        : await queryClient.fetchQuery(effectivePolicyQuery);
      return [
        ...sources.filter((file): file is ArchiveFile => file !== null),
        ...(validations?.files ?? []).map(({ path, content }) => ({
          path,
          content,
        })),
        ...(effective?.content
          ? [{ path: EFFECTIVE_POLICY_PATH, content: effective.content }]
          : []),
      ];
    },
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

/** The composed document, beside the sources it was composed from. */
const EFFECTIVE_POLICY_PATH = "effective-policy.toml";

/**
 * Where a file goes in the archive. A bundled battery's entry is its bare
 * name, so it gets a file under `batteries/`; an uploaded battery's entry and
 * a repository file are already paths.
 */
function archivePath(file: PolicyFile): string {
  const entry = file.entry ?? file.path;
  if (file.kind !== "battery" || entry.includes("/")) return entry;
  return `batteries/${entry.endsWith(".toml") ? entry : `${entry}.toml`}`;
}
