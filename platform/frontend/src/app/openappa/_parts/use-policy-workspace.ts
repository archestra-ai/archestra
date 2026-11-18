"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { usePolicyDeclarations } from "@/lib/openappa-batteries.query";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";
import { appaGitHost } from "./appa-git-host";
import { batteryDisplayName } from "./battery-display-name";
import { BATTERY_STATUS } from "./battery-status";
import { compositionNotice, enforcedStatus } from "./composition-view";
import {
  githubPolicyFileUrl,
  githubRepositoryFileUrl,
} from "./github-managed-policy-notice";
import type { PolicyFile } from "./policy-files";

export type PolicyWorkspace = ReturnType<typeof usePolicyWorkspace>;

/**
 * The Policy page's files and which one is open. The URL holds the open file,
 * a focused line and the view; opening a file writes it with
 * `history.pushState`, so the switch is immediate and the back button walks
 * the files visited.
 */
export function usePolicyWorkspace() {
  const declarations = usePolicyDeclarations();
  const sync = useAppaGithubSync();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const { data: canUpdate } = useHasPermissions({
    guardrailsPolicy: ["update"],
  });

  const activeEntry = searchParams.get("entry");
  const lineParam = Number(searchParams.get("line"));
  const focusLine =
    Number.isSafeInteger(lineParam) && lineParam > 0 ? lineParam : undefined;
  const view: PolicyView =
    searchParams.get("view") === "effective" ? "effective" : "source";

  const rootPath = sync.data?.source?.path || "policy.toml";
  // The self-service folder's files are MCP servers' rules; any other file
  // the root includes is the repository's own.
  const selfService = sync.data?.selfService;
  const serversFolder =
    selfService?.enabled && selfService.directory
      ? `${selfService.directory}/`
      : null;

  const files = useMemo<PolicyFile[]>(() => {
    const data = declarations.data;
    const root: PolicyFile = {
      key: "root",
      entry: null,
      path: rootPath,
      name: baseName(rootPath),
      kind: "root",
      label: "Organization policy",
      disabled: false,
    };
    if (!data) return [root];
    return [
      root,
      ...data.batteries.map((battery): PolicyFile => {
        const status = enforcedStatus(data, battery);
        return {
          key: battery.entry,
          entry: battery.entry,
          path: battery.entry,
          name: baseName(battery.entry),
          kind: "battery",
          label: batteryDisplayName(battery.name),
          status,
          statusLabel: BATTERY_STATUS[status].label,
          severity: BATTERY_STATUS[status].severity,
          disabled: battery.status === "unavailable",
        };
      }),
      // The repository's files the root folds in, in include order.
      ...data.repositoryFiles.map(
        (file): PolicyFile => ({
          key: file.path,
          entry: file.path,
          path: file.path,
          name: baseName(file.path),
          kind: "repository",
          label: file.path,
          mcpServerRules: Boolean(
            serversFolder && file.path.startsWith(serversFolder),
          ),
          disabled: false,
        }),
      ),
    ];
  }, [declarations.data, rootPath, serversFolder]);

  // A linked entry opens before the declarations name it, and when they fail.
  const active: PolicyFile =
    files.find((file) => file.entry === activeEntry) ??
    (activeEntry
      ? {
          key: activeEntry,
          entry: activeEntry,
          path: activeEntry,
          name: baseName(activeEntry),
          kind: "repository",
          label: activeEntry,
          disabled: false,
        }
      : files[0]);

  const navigate = useCallback(
    (next: { entry: string | null; line?: number; view: PolicyView }) => {
      const params = new URLSearchParams();
      if (next.entry) params.set("entry", next.entry);
      if (next.line) params.set("line", String(next.line));
      if (next.view === "effective") params.set("view", "effective");
      const query = params.toString();
      window.history.pushState(
        null,
        "",
        query ? `${pathname}?${query}` : pathname,
      );
    },
    [pathname],
  );
  const open = useCallback(
    (entry: string | null, line?: number) =>
      navigate({ entry, line, view: "source" }),
    [navigate],
  );
  const setView = useCallback(
    (next: PolicyView) => navigate({ entry: activeEntry, view: next }),
    [navigate, activeEntry],
  );

  const managed = declarations.data?.managedInGithub === true;
  return {
    files,
    active,
    focusLine,
    view,
    /** Open a file by its include entry; null opens the organization policy. */
    open,
    setView,
    /** The policy lives in a connected repository and changes there. */
    managed,
    /** "GitHub" or "GitLab". */
    gitLabel: appaGitHost(sync.data).label,
    /** The connected repository's policy file, to read. */
    repositoryUrl: managed ? githubPolicyFileUrl(sync.data, "blob") : null,
    /** Where the open file is changed in the repository; null for a battery. */
    editUrl: !managed
      ? null
      : active.kind === "root"
        ? githubPolicyFileUrl(sync.data, "edit")
        : active.kind === "repository" && active.entry
          ? githubRepositoryFileUrl(sync.data, active.entry, "edit")
          : null,
    /** The policy changes through the configuration agent in chat. */
    canChangeInChat: !managed && canUpdate === true,
    /** A refused composition; null while the latest revision composed. */
    notice: declarations.data ? compositionNotice(declarations.data) : null,
    /** Included batteries the composition does not enforce. */
    attentionCount: files.filter(
      (file) => file.kind === "battery" && file.severity !== "ok",
    ).length,
    guideUrl: getDocsUrl(
      DocsPage.PlatformAiToolGuardrails,
      "configure-with-the-agent",
    ),
  };
}

type PolicyView = "source" | "effective";

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
