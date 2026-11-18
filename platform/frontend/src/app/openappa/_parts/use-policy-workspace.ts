"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { usePolicyDeclarations } from "@/lib/openappa-batteries.query";
import {
  useAppaGithubSync,
  useServerRulesAccess,
} from "@/lib/openappa-github-sync.query";
import { appaGitHost } from "./appa-git-host";
import { batteryDisplayName } from "./battery-display-name";
import { BATTERY_STATUS } from "./battery-status";
import { compositionNotice, enforcedStatus } from "./composition-view";
import {
  githubPolicyFileUrl,
  githubRepositoryFileUrl,
  useManagedValidationsLink,
} from "./github-managed-policy-notice";
import type { PolicyFile } from "./policy-files";
import {
  useValidationSuite,
  validationEntry,
  validationPathOf,
} from "./validation-context";
import { validationFileStates, validationName } from "./validation-run-history";

export type PolicyWorkspace = ReturnType<typeof usePolicyWorkspace>;

/**
 * The Policy page's files and which one is open. The URL holds the open file,
 * a focused line and the view; opening a file writes it with
 * `history.pushState`, so the switch is immediate and the back button walks
 * the files visited.
 */
export function usePolicyWorkspace() {
  const sync = useAppaGithubSync();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const { data: canUpdate } = useHasPermissions({
    guardrailsPolicy: ["update"],
  });

  // A reader with no Guardrails permission sees their MCP servers' rules
  // files and nothing else of the policy.
  const serverRules = useServerRulesAccess();
  const scoped = serverRules.scoped === true;
  const declarations = usePolicyDeclarations(serverRules.scoped === false);
  // The organization's validations: files of the policy like any other.
  const suite = useValidationSuite();
  const validationsLink = useManagedValidationsLink(
    suite?.collection.activeDirectory ?? "",
  );
  const validationFiles = useMemo<PolicyFile[]>(() => {
    if (!suite || scoped) return [];
    const states = validationFileStates(suite.files, suite.history.data ?? []);
    return suite.files.map(
      (file): PolicyFile => ({
        key: validationEntry(file.path),
        entry: validationEntry(file.path),
        path: file.path,
        name: baseName(file.path),
        kind: "validation",
        label: file.path,
        validation: {
          status: states.get(file.path)?.status ?? "not_run",
          title: validationName(file),
        },
        disabled: false,
      }),
    );
  }, [suite, scoped]);

  const activeEntry = searchParams.get("entry");
  const lineParam = Number(searchParams.get("line"));
  const focusLine =
    Number.isSafeInteger(lineParam) && lineParam > 0 ? lineParam : undefined;
  const view: PolicyView =
    // Only once the reader is known to hold the Guardrails permission.
    searchParams.get("view") === "effective" && serverRules.scoped === false
      ? "effective"
      : "source";

  const rootPath = sync.data?.source?.path || "policy.toml";
  // The self-service folder's files are MCP servers' rules; any other file
  // the root includes is the repository's own.
  const selfService = sync.data?.selfService;
  const serversFolder =
    selfService?.enabled && selfService.directory
      ? `${selfService.directory}/`
      : null;

  const files = useMemo<PolicyFile[]>(() => {
    if (scoped)
      return serverRules.files.map(
        (file): PolicyFile => ({
          key: file.path,
          entry: file.path,
          path: file.path,
          name: baseName(file.path),
          kind: "repository",
          label: file.path,
          mcpServerRules: true,
          servers: file.servers,
          canEdit: file.canEdit,
          disabled: false,
        }),
      );
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
    if (!data) return [root, ...validationFiles];
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
          batteryName: battery.name,
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
      ...validationFiles,
    ];
  }, [
    declarations.data,
    rootPath,
    serversFolder,
    scoped,
    serverRules.files,
    validationFiles,
  ]);

  // A linked entry opens before the declarations name it, and when they fail.
  const active: PolicyFile =
    files.find((file) => file.entry === activeEntry) ??
    (activeEntry
      ? {
          key: activeEntry,
          entry: activeEntry,
          path: validationPathOf(activeEntry) ?? activeEntry,
          name: baseName(activeEntry),
          kind: validationPathOf(activeEntry) ? "validation" : "repository",
          label: activeEntry,
          disabled: false,
        }
      : (files[0] ?? NO_FILE));

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
    /** Only the reader's MCP servers' rules files are theirs to see. */
    scoped,
    /** Whether the reader's access is known yet. */
    isPending: serverRules.scoped === null,
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
    editUrl:
      active.kind === "validation"
        ? suite?.github && validationsLink.href
          ? `${validationsLink.href}/${active.path}`
          : null
        : !managed
          ? null
          : active.kind === "root"
            ? githubPolicyFileUrl(sync.data, "edit")
            : active.kind === "repository" && active.entry
              ? githubRepositoryFileUrl(sync.data, active.entry, "edit")
              : null,
    /** The validations, once they are there to show; null for a reader of server rules. */
    validations: scoped ? null : suite,
    /** The policy changes through the configuration agent in chat. */
    canChangeInChat: !managed && canUpdate === true,
    /** A refused composition; null while the latest revision composed. */
    notice: declarations.data ? compositionNotice(declarations.data) : null,
    /** Included batteries the composition does not enforce. */
    attentionCount: files.filter(
      (file) => file.kind === "battery" && file.severity !== "ok",
    ).length,
    /** How a policy is written: OpenAPPA's own guide to its contracts. */
    guideUrl: "https://www.openappa.com/contracts",
  };
}

type PolicyView = "source" | "effective";

/** What is open before a reader's files are known: nothing to load. */
const NO_FILE: PolicyFile = {
  key: "",
  entry: null,
  path: "",
  name: "",
  kind: "repository",
  label: "",
  disabled: true,
};

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
