import { randomUUID } from "node:crypto";
import { isBuiltInCatalogId, slugifyMcpServerName } from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import logger from "@/logging";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import McpCatalogTeamModel from "@/models/mcp-catalog-team";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import ToolModel from "@/models/tool";
import UserModel from "@/models/user";
import { catalogToolPrefixes } from "@/openappa/batteries";
import {
  asRecord,
  governsServerTool,
  includedFileErrors,
  includesServerRules,
  includesServerRulesFolder,
  isServerRulesBranch,
  parsePolicyToml,
  repositoryIncludePaths,
  serverRulesBranch,
  serverRulesInclude,
  serverRulesPath,
  withRequester,
  withServerRulesFolderIncluded,
} from "@/openappa/policy-text";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { policyDiff } from "@/services/guardrails-policy-proposal";
import {
  githubFetch,
  githubJson,
  githubPolicyChangeErrors,
} from "@/services/openappa-github";
import {
  configuredServerRulesFolder,
  openappaRepositoryIncludes,
  repositoryPath,
  resolveOpenAppaGithubAccess,
} from "@/services/openappa-github-access";
import {
  checkIntegrationId,
  heldMergeReason,
  listedNames,
  ownersAsNamedFor,
  ownersNotEditable,
  POLICY_CHECK_NAME,
  RETRY_REFUSED_MERGE,
  rulesFileRefusal,
  rulesFileServers,
  selfServiceActive,
  selfServiceAutoMergeActive,
  selfServiceSetupComplete,
  storedPullCheck,
  syncAppaGithubPolicy,
} from "@/services/openappa-github-sync";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";

/**
 * An MCP server's own Guardrails rules, kept in its file in the Git sync
 * repository's self-service folder (`mcp/<tool prefix>.toml` by default) and
 * included by `appa.toml`, by name or with every server's through
 * `<folder>/*.toml`.
 *
 * Archestra decides only who may propose a change: whoever may edit the
 * server in the MCP registry, by the same rule as the registry's own edit.
 * Every change is a pull request (a merge request on GitLab) on the policy
 * repository; whether and when it applies is the repository's review to
 * decide, and Git sync applies it once merged. Nothing is stored here.
 */

/** The branch of the pull request that includes the self-service folder. */
const INCLUDE_BRANCH = "archestra/openappa-self-service";

type Caller = { organizationId: string; userId: string };

/** What a caller reads about one server's rules. */
export async function getServerRules(params: Caller & { catalogId: string }) {
  const [root, source] = await Promise.all([
    guardrailsPolicyService.get(params.organizationId),
    OpenAppaGithubSyncModel.find(params.organizationId),
  ]);
  const server = await serverFor(params, configuredServerRulesFolder());
  // Off, there is nothing to read: the file is the organization's policy,
  // and the registry shows no action. The Keeper passes the reason on.
  if (source?.interval && source.repo && !selfServiceActive(source))
    throw new ApiError(409, SELF_SERVICE_OFF);
  if (source?.interval && source.repo)
    await requireSelfServiceComplete(params.organizationId);
  const included = includesServerRules(root.content, server.path);
  const accepted = await acceptedFile({
    organizationId: params.organizationId,
    path: server.path,
  });
  // Every rule for this server's tools, wherever the policy keeps it: the
  // root's own, then each repository file the root includes, the server's
  // own file among them. A change still goes to the server's own file.
  const rules = await serverRulesAcross({
    organizationId: params.organizationId,
    root: root.content,
    rootPath: source?.path ?? "appa.toml",
    prefix: server.prefix,
  });
  return {
    mcpServer: {
      id: server.id,
      name: server.name,
      toolPrefix: server.prefix,
    },
    canEdit: server.canEdit,
    path: server.path,
    sharedWith: server.sharedWith,
    hiddenCopies: server.hiddenCopies,
    included,
    content: accepted,
    // A server without a file yet starts from one that names every tool.
    ...(accepted === null
      ? {
          starter: starterServerRules(
            server,
            root.content,
            serverRulesInclude(configuredServerRulesFolder()),
          ),
        }
      : {}),
    repository: repositoryView(source),
    tools: server.tools,
    // The organization's own rules for these tools come first, so they win.
    rootRules: rootToolRules(root.content)
      .filter((rule) => governsServerTool(server.prefix, rule))
      .map((rule) => rule.name),
    rules,
    organizationHelpers: organizationHelpers(root.content),
    instruction: !repositoryView(source)
      ? "Git sync is not set up, so server rules cannot be proposed. Tell the user an administrator sets it up under Settings → Guardrails."
      : !server.canEdit
        ? `The user may read these rules but not propose a change: that takes edit access to ${server.needs(unseenServers("the user"))} in the MCP registry.${sharedSentence(server)}`
        : `${
            accepted === null
              ? `This server has no rules file of its own yet${rules.length > 0 ? "; `rules` lists the rules other files of the policy keep for its tools, which stay where they are" : ""}. Start from \`starter\`, which lists every tool with the organization's defaults; write the whole file, preview it with preview_guardrails_server_rules_change, explain it, and propose it with propose_guardrails_server_rules_change once the user agrees.`
              : "`rules` lists every rule for this server's tools across the policy, with the file each comes from; only the server's own file at `path` is changed here. To change it, write the whole file, preview it with preview_guardrails_server_rules_change, explain it, and propose it with propose_guardrails_server_rules_change once the user agrees."
          }${sharedSentence(server)}`,
    expectedCommit: source?.sourceCommit ?? null,
  };
}

/** The most tools the starter file lists one by one. */
const STARTER_TOOLS = 60;

/**
 * The first version of a server's rules file: every tool named, with no
 * rule, so the first proposal decides about each one on purpose. A tool the
 * file writes no rule for keeps the organization's own defaults.
 */
function starterServerRules(
  server: { name: string; prefix: string; tools: string[] },
  root: string,
  include: string,
): string {
  const governed = new Set(
    rootToolRules(root)
      .filter((rule) => governsServerTool(server.prefix, rule))
      .map((rule) => rule.name),
  );
  const lines = [
    `# Guardrails rules for the MCP server ${server.name} (tools ${server.prefix}__*),`,
    "# kept by the people who may edit the server in the MCP registry. The",
    `# organization's appa.toml includes this file through ${include}.`,
    "# A rule appa.toml keeps for the same tool wins over one written here.",
    "",
    "[policy]",
    "version = 2",
    "",
    "# Each tool of the server. A tool with no rule here keeps the organization's",
    "# defaults. Write a rule for one by uncommenting its entry; a rule for",
    `# "${server.prefix}__*" covers every tool this file names no rule for,`,
    "# including tools the server gains later.",
  ];
  for (const tool of server.tools.slice(0, STARTER_TOOLS)) {
    lines.push(
      "",
      governed.has(tool)
        ? `# ${tool}: appa.toml keeps its own rule for this tool, which wins.`
        : `# ${tool}`,
      "# [[policy.tool]]",
      `# name = ${JSON.stringify(tool)}`,
      "# requires = {}",
      "# delta = {}",
    );
  }
  if (server.tools.length > STARTER_TOOLS)
    lines.push(
      "",
      `# ... and ${server.tools.length - STARTER_TOOLS} more tools, all ${server.prefix}__*.`,
    );
  return `${lines.join("\n")}\n`;
}

/** Check a proposed file for one server; saves and opens nothing. */
export async function previewServerRulesChange(
  params: Caller & {
    catalogId: string;
    content: string;
    expectedCommit: string;
  },
) {
  const change = await checkedChange(params);
  return { stage: "preview" as const, ...change.view };
}

/** Open a pull request with one server's proposed file. */
export async function proposeServerRulesChange(
  params: Caller & {
    catalogId: string;
    content: string;
    expectedCommit: string;
    summary: string;
  },
) {
  const change = await checkedChange(params);
  if (!change.view.valid)
    throw new ApiError(400, change.view.errors.join("\n"));
  if (!change.rootChanged && change.view.before === params.content)
    throw new ApiError(400, "The proposed rules have no changes");
  const requester = await UserModel.getById(params.userId);
  const title = `Guardrails rules for ${change.server.name}`;
  const body = [
    params.summary.trim(),
    "",
    `Requested in ${archestraMcpBranding.appName} by ${requester?.name ?? "a user"}${requester?.email ? ` (${requester.email})` : ""}, who may edit ${await ownersAsNamedFor({ organizationId: params.organizationId, userId: params.userId, servers: change.server.owners })} in the MCP registry.`,
    `This changes \`${change.server.path}\`${change.rootChanged ? `, and adds \`${change.include}\` to \`${change.source.path}\`'s include list, so every MCP server's own rules file applies from then on` : ""}. It applies once merged and pulled by Git sync.`,
  ].join("\n");
  const files = [
    {
      path: repositoryPath(change.source, change.server.path),
      content: params.content,
    },
    ...(change.rootChanged
      ? [{ path: change.source.path, content: change.rootAfter }]
      : []),
  ];
  const head = serverRulesBranch(
    change.server.prefix,
    randomUUID().slice(0, 8),
  );
  // The commit names the person who asked, in a trailer GitHub's signature
  // for the App covers: the policy check reads it from there.
  const opened = await openGithubPull({
    ...change,
    title,
    message: requester ? withRequester(title, requester.email) : title,
    body,
    files,
    head,
  });
  return {
    stage: "proposed" as const,
    delivery: "pull_request" as const,
    ...opened,
    repo: change.source.repo,
    ...change.view,
    instruction: selfServiceAutoMergeActive(change.source)
      ? `Give the user the link. The pull request merges by itself within about a minute of its ${POLICY_CHECK_NAME} check passing; nobody needs to merge it, and Git sync then applies it. Follow it now: call get_guardrails_server_rules_change_status with this number, wait=true and the last phase as since, tell the user each change in one short sentence, and keep calling until done is true. Then say whether the rules are active, or what went wrong and what to do.`
      : `Give the user the link. Once its ${POLICY_CHECK_NAME} check passes, the user merges it on GitHub themselves, or anyone with write access to the repository does; no other approval is needed. Git sync then applies it. Check its state with get_guardrails_server_rules_change_status.`,
  };
}

/**
 * How long one status call may wait for the pull request to move on, and
 * how often it looks. The wait stays well inside the minute an MCP client
 * gives a call, GitHub's own answers included.
 */
const STATUS_WAIT = 40 * 1000;
const STATUS_POLL = 5 * 1000;

/** Where a server's rules pull request stands, from opened to applied. */
export const CHANGE_PHASES = [
  "check_pending",
  "check_failed",
  "check_passed",
  "merge_pending",
  "merge_refused",
  "merged",
  "applied",
  "closed",
] as const;
type ChangePhase = (typeof CHANGE_PHASES)[number];

/** Phases nothing moves on from by itself: the Keeper stops following there. */
const SETTLED: ReadonlySet<ChangePhase> = new Set([
  "check_failed",
  "check_passed",
  "merge_refused",
  "applied",
  "closed",
]);

/**
 * Where a server's rules pull request stands: its policy check, whether the
 * App merges it or someone must, the merge, and whether Git sync has applied
 * it. With `wait`, the call returns once the phase moves on from `since` (or
 * from the phase first seen), or settles, or after some forty seconds; the
 * Keeper follows an auto-merged pull request by calling it again until `done`.
 */
export async function getServerRulesChangeStatus(
  params: Caller & {
    catalogId: string;
    number: number;
    wait?: boolean;
    since?: ChangePhase;
    /** How long to wait and how often to look; tests shorten them. */
    waitMs?: number;
    pollMs?: number;
  },
) {
  let source = await requireSource(params.organizationId);
  await requireSelfServiceComplete(params.organizationId);
  const server = await serverFor(params, configuredServerRulesFolder());
  // The check posted on the head is read too, which takes Checks.
  const { token, api } = await githubWriter(source, { checks: "read" });
  const base = `${api}/repos/${source.repo}`;
  const appId = await checkIntegrationId(source);
  const poll = params.pollMs ?? STATUS_POLL;
  const deadline =
    Date.now() + (params.wait ? (params.waitMs ?? STATUS_WAIT) : 0);
  let baseline = params.since ?? null;
  let last: Awaited<ReturnType<typeof readChangeStatus>> | undefined;
  for (let read = 0; ; read += 1) {
    // Git sync may have applied the merge since the last look.
    if (read > 0) source = await requireSource(params.organizationId);
    // No look starts once the wait is over: the last one's answer stands.
    if (last && Date.now() >= deadline) return last;
    let status: Awaited<ReturnType<typeof readChangeStatus>>;
    try {
      status = await readChangeStatus({
        ...params,
        source,
        prefix: server.prefix,
        token,
        base,
        appId,
        // Every look in a wait is bounded by what the wait has left.
        ...(params.wait ? { deadline } : {}),
      });
    } catch (error) {
      // A host that fails for now is asked again while the wait lasts; a
      // refusal of the request itself (no such pull request) is not. Past
      // the wait, what the last look found is the answer.
      const transient =
        (error instanceof ApiError && error.statusCode >= 500) ||
        (error instanceof Error &&
          ["TimeoutError", "AbortError"].includes(error.name));
      if (!transient) throw error;
      if (!params.wait || Date.now() + poll >= deadline) {
        if (last) return last;
        throw error;
      }
      await pause(poll, deadline);
      continue;
    }
    last = status;
    baseline ??= status.phase;
    // No look is started that the wait has no room for.
    if (
      !params.wait ||
      status.done ||
      status.phase !== baseline ||
      Date.now() + poll >= deadline
    )
      return status;
    await pause(poll, deadline);
  }
}

function pause(ms: number, deadline: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, Math.min(ms, deadline - Date.now()))),
  );
}

async function readChangeStatus(params: {
  organizationId: string;
  number: number;
  source: Source;
  prefix: string;
  token: string;
  base: string;
  appId: number | undefined;
  /** When the caller's wait ends: no request outlives it. */
  deadline?: number;
}) {
  const { source, token, base } = params;
  // One signal for the look: GitHub's usual time, or what the wait has left.
  const signal =
    params.deadline !== undefined
      ? AbortSignal.timeout(
          Math.min(15_000, Math.max(1, params.deadline - Date.now())),
        )
      : undefined;
  const pull = await github<{
    number: number;
    html_url: string;
    state: string;
    merged?: boolean;
    merged_at?: string | null;
    merge_commit_sha?: string | null;
    head?: { ref?: string; sha?: string };
  }>({ token, url: `${base}/pulls/${params.number}`, signal });
  if (!isServerRulesBranch(pull.head?.ref ?? "", params.prefix))
    throw new ApiError(404, "No rules change for this server has that number");
  const merged = pull.merged === true && !!pull.merge_commit_sha;
  const autoMerge = selfServiceAutoMergeActive(source);
  const answer = (phase: ChangePhase, extra: StatusExtra = {}) => ({
    number: pull.number,
    url: pull.html_url,
    state: merged ? "merged" : pull.state === "open" ? "open" : "closed",
    applied: phase === "applied",
    phase,
    done: SETTLED.has(phase) || !!extra.syncFailed,
    autoMerge,
    ...extra,
    instruction: changeInstruction(phase, extra),
  });
  if (merged) {
    // Applied once the accepted commit contains the merge.
    const applied =
      source.sourceCommit === pull.merge_commit_sha ||
      ["ahead", "identical"].includes(
        (
          await github<{ status?: string }>({
            token,
            url: `${base}/compare/${pull.merge_commit_sha}...${source.sourceCommit}`,
            signal,
          })
        ).status ?? "",
      );
    if (applied) return answer("applied");
    // A pull since the merge that failed is what keeps it from applying:
    // nothing moves on until that is put right.
    const mergedAt = pull.merged_at ? Date.parse(pull.merged_at) : Number.NaN;
    if (
      source.lastSyncError &&
      source.lastSyncedAt &&
      (Number.isNaN(mergedAt) || source.lastSyncedAt.getTime() > mergedAt)
    )
      return answer("merged", { syncFailed: { reason: source.lastSyncError } });
    // A pull applies what is merged; queue one rather than wait for the schedule.
    await OpenAppaGithubSyncModel.enqueue(params.organizationId);
    return answer("merged");
  }
  if (pull.state !== "open") return answer("closed");
  const head = pull.head?.sha ?? "";
  // The check this deployment posted on the head, if it has yet.
  const runs = /^[a-f0-9]{40}$/.test(head)
    ? await github<{
        check_runs?: Array<{
          status?: string;
          conclusion?: string | null;
          completed_at?: string | null;
          output?: { title?: string | null; summary?: string | null };
        }>;
      }>({
        token,
        url: `${base}/commits/${head}/check-runs?check_name=${encodeURIComponent(POLICY_CHECK_NAME)}${params.appId ? `&app_id=${params.appId}` : ""}&per_page=10`,
        signal,
      }).then((listed) => listed.check_runs ?? [])
    : [];
  const run = runs.find((entry) => entry.status === "completed");
  if (!run) return answer("check_pending", { check: { state: "pending" } });
  // Only success counts for the required check; skipped, cancelled and the
  // rest leave the pull request where a failure does.
  const check = {
    state: run.conclusion === "success" ? "passed" : "failed",
    ...(run.output?.title ? { title: run.output.title } : {}),
    ...(run.output?.summary
      ? { summary: run.output.summary.slice(0, 2000) }
      : {}),
  };
  if (check.state === "failed") return answer("check_failed", { check });
  if (!autoMerge) return answer("check_passed", { check });
  const merge = pull.merge_commit_sha;
  const stored = await storedPullCheck(source, {
    head,
    result: merge && /^[a-f0-9]{40}$/.test(merge) ? merge : head,
  });
  // The App holds off the whole repository when it may not merge there:
  // that stands over whatever one pull request's merge met.
  const held = await heldMergeReason(source);
  if (held)
    return answer("merge_refused", {
      check,
      mergeRefused: { reason: held, at: new Date().toISOString() },
    });
  if (stored?.mergeRefusedAt !== undefined) {
    const mergeRefused = {
      reason: stored.mergeRefusedReason ?? "GitHub refused the merge",
      at: new Date(stored.mergeRefusedAt).toISOString(),
    };
    // A check just posted can take GitHub a moment to count: the first
    // refusal is tried again next minute, and only a second one stands.
    return answer(
      (stored.mergeRefusals ?? 1) > 1 ? "merge_refused" : "merge_pending",
      { check, mergeRefused },
    );
  }
  // A merge that has not come for as long as a refusal holds is not waited
  // on any longer: people take it from here, and the App keeps trying.
  const completedAt = run.completed_at ? Date.parse(run.completed_at) : NaN;
  if (
    !Number.isNaN(completedAt) &&
    Date.now() - completedAt > RETRY_REFUSED_MERGE
  )
    return answer("merge_refused", {
      check,
      mergeRefused: {
        reason:
          "the GitHub App has not merged it since the check passed; it keeps trying every minute",
        at: new Date().toISOString(),
      },
    });
  return answer("merge_pending", { check });
}

type StatusExtra = {
  check?: { state: string; title?: string; summary?: string };
  mergeRefused?: { reason: string; at: string };
  /** Git sync failed on a pull since the merge: the rules are not active. */
  syncFailed?: { reason: string };
};

/** What the Keeper does next at each phase, and what it tells the user. */
function changeInstruction(phase: ChangePhase, extra: StatusExtra): string {
  const again = (since: ChangePhase) =>
    `Call this again with wait=true and since="${since}", and tell the user only when something changes.`;
  switch (phase) {
    case "check_pending":
      return `The ${POLICY_CHECK_NAME} check posts within a minute. ${again(phase)}`;
    case "check_failed":
      return `The ${POLICY_CHECK_NAME} check failed, so this pull request cannot merge and nothing is applied. Tell the user what failed in plain words${extra.check?.title ? ` (${extra.check.title})` : ""}, then offer to fix the file and propose it again, which opens a new pull request. Stop following this one.`;
    case "check_passed":
      return `The ${POLICY_CHECK_NAME} check passed. The user merges the pull request on GitHub themselves, or anyone with write access to the repository does; Git sync then applies it. Tell the user; follow it further only if they ask.`;
    case "merge_pending":
      return extra.mergeRefused
        ? `The ${POLICY_CHECK_NAME} check passed; GitHub refused the first merge (${extra.mergeRefused.reason}), which it does while the check is still being counted, and the App tries again within a minute. ${again(phase)}`
        : `The ${POLICY_CHECK_NAME} check passed, and the App merges the pull request within about a minute. ${again(phase)}`;
    case "merge_refused":
      return `The App did not merge the pull request${extra.mergeRefused ? `: ${extra.mergeRefused.reason}` : ""}. It stays open and nothing is applied. Tell the user in plain words why, and that someone with write access can merge it on GitHub meanwhile; the App tries again in fifteen minutes. Stop following it.`;
    case "merged":
      return extra.syncFailed
        ? `Merged, but Git sync could not apply it: ${extra.syncFailed.reason} The rules are not active until an administrator puts the policy repository right; the Git sync card shows the same error. Tell the user, and stop here.`
        : `Merged; Git sync is pulling it now. ${again(phase)}`;
    case "applied":
      return "Done: the pull request is merged and the rules are active. Tell the user, and stop here.";
    case "closed":
      return "The pull request was closed without merging, so nothing is applied. Tell the user; propose the change again if they still want it.";
  }
}

// ===

/** One server as its rules see it, and whether the caller may change them. */
async function serverFor(
  params: Caller & { catalogId: string },
  /** The self-service folder its file lives in. */
  folder: string,
) {
  const { organizationId, userId, catalogId } = params;
  const catalog = await InternalMcpCatalogModel.findById(catalogId, {
    organizationId,
    userId,
    expandSecrets: false,
  });
  if (!catalog)
    throw new ApiError(404, "MCP server not found or you don't have access");
  if (isBuiltInCatalogId(catalog.id))
    throw new ApiError(
      400,
      "The built-in tools are governed by the organization's own policy, not by a server's rules",
    );
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  await ResourcePermissions.require({
    organizationId,
    userId,
    resource: "mcpRegistry",
    scope: catalog.id,
    action: "read",
  });
  // SPDX-SnippetEnd
  const tools = (await ToolModel.getToolNamesByCatalogIds([catalog.id]))
    .map((tool) => tool.name)
    .sort();
  if (tools.length === 0)
    throw new ApiError(
      409,
      `${catalog.name} has no tools yet. Connect it first, so its rules have tools to name.`,
    );
  // The file is named by the server's own slug, and governs every server
  // whose tools carry that prefix: those servers share it.
  const prefix = slugifyMcpServerName(catalog.name);
  const prefixes = await catalogToolPrefixes(organizationId, {
    targets: [prefix],
    catalogIds: [catalog.id],
  });
  const refusal = rulesFileRefusal({ catalog, tools, prefixes });
  if (refusal) throw new ApiError(409, refusal);
  const servers = await rulesFileServers(prefix, prefixes);
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  // The registry's own edit rule: whoever may edit every server that owns
  // the file may propose its rules.
  const notEditable = await ownersNotEditable({
    organizationId,
    userId,
    servers,
  });
  // SPDX-SnippetEnd
  const readable = new Set(
    await McpCatalogTeamModel.getUserAccessibleCatalogIds(
      userId,
      false,
      organizationId,
    ),
  );
  const others = servers.filter((server) => server.id !== catalog.id);
  return {
    id: catalog.id,
    name: catalog.name,
    prefix,
    path: serverRulesPath(folder, prefix),
    canEdit: notEditable.length === 0,
    /**
     * The owners the caller may not edit, named when the caller may see
     * them; the rest counted as `hidden` words them.
     */
    needs: (hidden: (count: number) => string) => {
      const named = notEditable
        .filter((server) => server.id === catalog.id || readable.has(server.id))
        .map((server) => server.name);
      const unseen = notEditable.length - named.length;
      return listedNames([...named, ...(unseen > 0 ? [hidden(unseen)] : [])]);
    },
    owners: servers.filter((server) => server.owner),
    sharedWith: others.filter((server) => readable.has(server.id)),
    hiddenCopies: others.filter(
      (server) => server.scope === "personal" && !readable.has(server.id),
    ).length,
    tools,
  };
}

/** Owners of a file the caller cannot see, as a sentence counts them. */
function unseenServers(who: string): (count: number) => string {
  return (count) =>
    count === 1
      ? `an MCP server ${who} cannot see`
      : `${count} MCP servers ${who} cannot see`;
}

/** What the Keeper says about a file other servers share, if any. */
function sharedSentence(server: {
  sharedWith: Array<{ name: string }>;
  hiddenCopies: number;
}): string {
  const names = [
    ...server.sharedWith.map((other) => other.name),
    ...(server.hiddenCopies > 0
      ? [
          `${server.hiddenCopies} personal ${server.hiddenCopies === 1 ? "copy" : "copies"} the user cannot see`,
        ]
      : []),
  ];
  return names.length === 0
    ? ""
    : ` The file is shared: its rules also govern ${listedNames(names)}, whose tools carry the same prefix.`;
}

/** The checks a preview and a proposal share, and what the change would do. */
async function checkedChange(
  params: Caller & {
    catalogId: string;
    content: string;
    expectedCommit: string;
  },
) {
  const source = await requireSource(params.organizationId);
  await requireSelfServiceComplete(params.organizationId);
  const folder = configuredServerRulesFolder();
  const include = serverRulesInclude(folder);
  const server = await serverFor(params, folder);
  if (!server.canEdit)
    throw new ApiError(
      403,
      `You may propose ${server.name}'s Guardrails rules only if you may edit ${server.needs(unseenServers("you"))} in the MCP registry`,
    );
  if (source.sourceCommit !== params.expectedCommit)
    throw new ApiError(
      409,
      "The policy repository moved on since these rules were read. Read them again.",
    );
  // The same check Git sync makes on every commit, scope included.
  const shape = includedFileErrors(server.path, params.content, folder);
  if (shape.length > 0) throw new ApiError(400, shape.join("\n"));
  const root = await guardrailsPolicyService.get(params.organizationId);
  // A root that folds in no server's file gets them all at once: one review
  // of `appa.toml`, and no server's later file needs another.
  const rootChanged = !includesServerRules(root.content, server.path);
  const rootAfter = rootChanged
    ? await withInclude(root.content, folder)
    : root.content;
  const before =
    (await acceptedFile({
      organizationId: params.organizationId,
      path: server.path,
    })) ?? "";
  const validation = await guardrailsPolicyService.validate(rootAfter, {
    organizationId: params.organizationId,
    previous: root.content,
    files: new Map([[server.path, params.content]]),
  });
  return {
    server,
    source,
    include,
    rootAfter,
    rootChanged,
    view: {
      mcpServer: { id: server.id, name: server.name },
      path: server.path,
      before,
      after: params.content,
      ...policyDiff({ before, after: params.content, path: server.path }),
      ...(rootChanged
        ? {
            rootChange: policyDiff({
              before: root.content,
              after: rootAfter,
              path: source.path,
            }).diff,
          }
        : {}),
      ...validation,
    },
  };
}

/**
 * Every `[[policy.tool]]` rule for the server's tools across the policy:
 * the root's first, which win, then each repository file the root includes
 * (a glob's matches with it), as merged at the accepted commit. A file that
 * cannot be read, or no accepted commit yet, leaves the root's rules alone.
 */
async function serverRulesAcross(params: {
  organizationId: string;
  root: string;
  rootPath: string;
  prefix: string;
}): Promise<
  Array<{ file: string; name: string; rule: Record<string, unknown> }>
> {
  const files = new Map<string, string>([[params.rootPath, params.root]]);
  const entries = repositoryIncludePaths(params.root);
  if (entries.length > 0)
    try {
      for (const [path, text] of await openappaRepositoryIncludes.readAccepted({
        organizationId: params.organizationId,
        paths: entries,
      }))
        files.set(path, text);
    } catch (error) {
      if (!(error instanceof ApiError && error.statusCode === 409)) throw error;
    }
  return [...files].flatMap(([file, text]) =>
    rootToolRules(text)
      .filter((rule) => governsServerTool(params.prefix, rule))
      .map((rule) => ({ file, name: String(rule.name), rule })),
  );
}

/** The root's own `[[policy.tool]]` entries, `server` qualifier included. */
function rootToolRules(root: string): Array<Record<string, unknown>> {
  const tools = asRecord(parsePolicyToml(root)?.policy)?.tool;
  return (Array.isArray(tools) ? tools : []).flatMap((entry) => {
    const rule = asRecord(entry);
    return rule ? [rule] : [];
  });
}

/**
 * The organization's authorities and sanitizers, which a server's rules use
 * but never declare: a rule reaches an authority through an attention mark
 * it permits (`requires = { attention = [...] }`), or by its tags, and a
 * sanitizer by its tags. A `tool_output` sanitizer also needs the tool under
 * `[policy.deployment] confined_results`. Names, tags and permits only; the
 * rest of the policy stays with those who may read it.
 */
function organizationHelpers(root: string) {
  const policy = asRecord(parsePolicyToml(root)?.policy) ?? {};
  const helpers = (kind: string) =>
    (Array.isArray(policy[kind]) ? policy[kind] : []).flatMap((entry) => {
      const helper = asRecord(entry);
      return helper && typeof helper.name === "string"
        ? [
            {
              name: helper.name,
              ...(helper.on !== undefined ? { on: helper.on } : {}),
              tags: Array.isArray(helper.tags) ? helper.tags : [],
              permits: helper.permits ?? {},
            },
          ]
        : [];
    });
  return {
    authorities: helpers("authority"),
    sanitizers: helpers("sanitizer"),
  };
}

async function withInclude(root: string, folder: string): Promise<string> {
  try {
    return await withServerRulesFolderIncluded(root, folder);
  } catch (error) {
    throw new ApiError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
}

// =============================================================================
// The include that makes the servers' files apply
// =============================================================================

/**
 * Whether the policy file includes the self-service folder, which is what
 * makes each server's file apply: included, or the open pull request that
 * adds the line waits, or neither. Read from the repository, not the accepted
 * copy alone: an include merged but not pulled yet counts, and a pull request
 * left from an earlier folder does not.
 */
export async function selfServiceIncludeState(organizationId: string) {
  const source = await OpenAppaGithubSyncModel.find(organizationId);
  const folder = configuredServerRulesFolder();
  let situation: IncludeSituation;
  try {
    situation = await includeSituation({ organizationId, source, folder });
  } catch (error) {
    // A repository that cannot be read for now says so, rather than
    // "missing", which would offer to open a pull request that may exist.
    if (!(error instanceof ApiError && error.statusCode === 502)) throw error;
    logger.warn(
      { organizationId, error },
      "OpenAPPA could not read where the self-service include stands",
    );
    return { folder, state: "unknown" as const };
  }
  return situation.state === "pull_open"
    ? { folder, state: situation.state, pull: situation.pull }
    : { folder, state: situation.state };
}

type IncludeSituation =
  | { state: "included" }
  | { state: "pull_open"; pull: { number: number; url: string } }
  | {
      state: "missing";
      /** Our open pull request for another folder, to close before a new one. */
      stale?: { number: number; url: string };
    };

/**
 * Where the folder's include stands, in this order: the accepted policy has
 * it; the synced branch has it, so a sync is queued and nothing is opened;
 * our pull request for it waits; our pull request waits for another folder;
 * nothing.
 */
async function includeSituation(params: {
  organizationId: string;
  source: Awaited<ReturnType<typeof OpenAppaGithubSyncModel.find>>;
  folder: string;
}): Promise<IncludeSituation> {
  const { organizationId, source, folder } = params;
  const root = await guardrailsPolicyService.get(organizationId);
  if (includesServerRulesFolder(root.content, folder))
    return { state: "included" };
  if (
    !source?.interval ||
    !source.repo ||
    !source.path ||
    !source.githubAppConfigId
  )
    return { state: "missing" };
  const repo = source.repo;
  const { token, api } = await githubWriter({
    ...source,
    repo,
    githubAppConfigId: source.githubAppConfigId,
  });
  const base = `${api}/repos/${repo}`;
  const branch =
    source.ref ??
    (await github<{ default_branch: string }>({ token, url: base }))
      .default_branch;
  const atBranch = await rootAt({
    token,
    base,
    path: source.path,
    ref: branch,
  });
  if (atBranch !== null && includesServerRulesFolder(atBranch, folder)) {
    // Merged, not pulled yet: the next pull brings it, so nothing to open.
    await OpenAppaGithubSyncModel.enqueue(organizationId);
    return { state: "included" };
  }
  const pull = await openPullFor({ token, base, repo, head: INCLUDE_BRANCH });
  // A lookup that failed is not an absent pull request: closing or replacing
  // one on that reading would lose a valid pull request to a passing fault.
  if (pull === undefined)
    throw new ApiError(
      502,
      "Could not look for the include pull request on GitHub; try again",
    );
  if (pull === null) return { state: "missing" };
  const atHead = pull.headSha
    ? await rootAt({ token, base, path: source.path, ref: pull.headSha })
    : null;
  return atHead !== null && includesServerRulesFolder(atHead, folder)
    ? { state: "pull_open", pull: { number: pull.number, url: pull.url } }
    : { state: "missing", stale: { number: pull.number, url: pull.url } };
}

/**
 * The policy file's text at `ref`, or null when the ref has none. A read
 * that failed throws: "unreadable" must not pass for "absent".
 */
async function rootAt(params: {
  token: string;
  base: string;
  path: string;
  ref: string;
}): Promise<string | null> {
  const path = params.path.split("/").map(encodeURIComponent).join("/");
  const response = await githubFetch({
    url: `${params.base}/contents/${path}?ref=${encodeURIComponent(params.ref)}`,
    token: params.token,
    accept: "application/vnd.github.raw+json",
  }).catch(() => {
    throw new ApiError(502, "Could not read the policy file from GitHub");
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new ApiError(502, `GitHub returned HTTP ${response.status}`);
  return response.text();
}

/**
 * Open the pull request that adds `<folder>/*.toml` to the policy file's
 * include list, in the caller's name, when the file lacks it and no such
 * pull request waits. Returns what was opened, or null when nothing was:
 * an include already in place, or on its way, needs no pull request, and
 * one of ours left from an earlier folder is closed first.
 */
export async function ensureSelfServiceInclude(params: Caller) {
  // A source just saved has no accepted commit yet: pull it now rather than
  // wait for the schedule, so the pull request opens at once. A source the
  // feature is not in force on (no GitHub App) is left to its schedule.
  const saved = await OpenAppaGithubSyncModel.find(params.organizationId);
  if (selfServiceActive(saved) && !saved.sourceCommit)
    await syncAppaGithubPolicy(params.organizationId);
  const source = await requireSource(params.organizationId);
  const folder = configuredServerRulesFolder();
  const entry = serverRulesInclude(folder);
  const situation = await includeSituation({
    organizationId: params.organizationId,
    source,
    folder,
  });
  if (situation.state !== "missing") return null;
  const root = await guardrailsPolicyService.get(params.organizationId);
  const { token, api } = await githubWriter(source);
  const base = `${api}/repos/${source.repo}`;
  if (situation.stale) {
    await github({
      token,
      url: `${base}/pulls/${situation.stale.number}`,
      method: "PATCH",
      body: {
        state: "closed",
        body: `Closed by ${archestraMcpBranding.appName}: the self-service folder is now \`${folder}/\`, and a new pull request includes it.`,
      },
    });
  }
  const after = await withInclude(root.content, folder);
  const requester = await UserModel.getById(params.userId);
  const title = `Include each MCP server's Guardrails rules file`;
  // Git keeps no empty folder: a README starts it, and says what goes there.
  const readme = repositoryPath(source, `${folder}/README.md`);
  const folderExists = await githubFetch({
    url: `${base}/contents/${repositoryPath(source, folder)}?ref=${source.sourceCommit}`,
    token,
  })
    .then((response) => response.ok)
    .catch(() => false);
  const body = [
    `Adds \`${entry}\` to \`${source.path}\`'s include list, so the rules file each MCP server keeps in \`${folder}/\` applies once merged and pulled by Git sync.${folderExists ? "" : ` Starts \`${folder}/\` with a README.`}`,
    "",
    `Requested in ${archestraMcpBranding.appName} by ${requester?.name ?? "an administrator"}${requester?.email ? ` (${requester.email})` : ""}, who turned MCP Guardrails Self-Service on.`,
  ].join("\n");
  // A branch left by an earlier, closed pull request would refuse the new ref.
  await deleteBranch({ token, base, head: INCLUDE_BRANCH });
  return openGithubPull({
    source,
    title,
    message: requester ? withRequester(title, requester.email) : title,
    body,
    files: [
      { path: source.path, content: after },
      ...(folderExists
        ? []
        : [
            {
              path: readme,
              content: serverRulesReadme(folder, source.path),
            },
          ]),
    ],
    head: INCLUDE_BRANCH,
  });
}

/** What the servers' folder is for, for whoever opens it on GitHub. */
function serverRulesReadme(folder: string, policyPath: string): string {
  const policyFile = policyPath.slice(policyPath.lastIndexOf("/") + 1);
  return [
    "# Guardrails rules per MCP server",
    "",
    `Each MCP server's Guardrails rules live here, one \`<tool prefix>.toml\` file per tool prefix, which \`${policyFile}\` includes through \`${folder}/*.toml\`. A file holds rules only for the tools that carry its prefix, and servers whose tools share a prefix share its file. A rule in \`${policyFile}\` for the same tool wins.`,
    "",
    `The people who may edit a server in the ${archestraMcpBranding.appName} MCP registry change its file through **Edit Guardrails** there, which opens a pull request. A shared file takes edit access to each server shared with a team or the organization. The ${archestraMcpBranding.appName} policy check on each pull request confirms the change.`,
    "",
  ].join("\n");
}

/** The file at the accepted commit, or null when the repository has none. */
async function acceptedFile(params: {
  organizationId: string;
  path: string;
}): Promise<string | null> {
  try {
    const files = await openappaRepositoryIncludes.readAccepted({
      organizationId: params.organizationId,
      paths: [params.path],
    });
    return files.get(params.path) ?? null;
  } catch (error) {
    // No accepted commit yet: there is no file to read.
    if (error instanceof ApiError && error.statusCode === 409) return null;
    throw error;
  }
}

function repositoryView(
  source: Awaited<ReturnType<typeof OpenAppaGithubSyncModel.find>>,
) {
  return source?.interval && source.repo && source.path && source.sourceCommit
    ? {
        repo: source.repo,
        branch: source.ref,
        policyFile: source.path,
        commit: source.sourceCommit,
        provider: source.gitlabTokenId ? "gitlab" : "github",
      }
    : null;
}

/** The refusal every server rules tool gives while self-service is off. */
const SELF_SERVICE_OFF =
  "MCP Guardrails Self-Service is off, so server rules cannot be read or proposed here. An administrator turns it on for the deployment with ARCHESTRA_OPENAPPA_SELF_SERVICE=enabled.";

const SELF_SERVICE_UNFINISHED =
  "MCP Guardrails Self-Service is not set up yet, so server rules cannot be read or proposed here. An administrator finishes the setup under Settings → Guardrails → Git sync with Finish setup: the branch ruleset, and the include that makes the servers' files apply.";

/**
 * The Keeper's tools and the registry's action open together, once Finish
 * setup is complete; before that, a proposal would merge unchecked or land
 * in a folder the policy does not include yet.
 */
async function requireSelfServiceComplete(organizationId: string) {
  if (!(await selfServiceSetupComplete(organizationId)))
    throw new ApiError(409, SELF_SERVICE_UNFINISHED);
}

async function requireSource(organizationId: string) {
  const source = await OpenAppaGithubSyncModel.find(organizationId);
  if (!source?.interval || !source.repo || !source.path || !source.sourceCommit)
    throw new ApiError(
      409,
      "Git sync is not set up, so server rules cannot be proposed. An administrator sets it up under Settings → Guardrails.",
    );
  if (!selfServiceActive(source)) throw new ApiError(409, SELF_SERVICE_OFF);
  return {
    ...source,
    repo: source.repo,
    path: source.path,
    sourceCommit: source.sourceCommit,
  };
}

type Source = Awaited<ReturnType<typeof requireSource>>;
type ChangedFile = { path: string; content: string };

/**
 * One commit on a new branch from the accepted commit, then a pull request
 * into the source branch: the repository's review sees exactly the change.
 */
async function openGithubPull(params: {
  source: Source;
  title: string;
  /** The commit message: the title, and who asked. */
  message: string;
  body: string;
  files: ChangedFile[];
  head: string;
}) {
  const { source } = params;
  const { token, api } = await githubWriter(source);
  const base = `${api}/repos/${source.repo}`;
  const branch =
    source.ref ??
    (await github<{ default_branch: string }>({ token, url: base }))
      .default_branch;
  const commit = await github<{ tree?: { sha?: string } }>({
    token,
    url: `${base}/git/commits/${source.sourceCommit}`,
  });
  const tree = await github<{ sha: string }>({
    token,
    url: `${base}/git/trees`,
    method: "POST",
    body: {
      base_tree: checkedSha(commit.tree?.sha),
      tree: params.files.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.content,
      })),
    },
  });
  const created = await github<{ sha: string }>({
    token,
    url: `${base}/git/commits`,
    method: "POST",
    // No author or committer: GitHub signs the commit for the App only then.
    body: {
      message: params.message,
      tree: checkedSha(tree.sha),
      parents: [source.sourceCommit],
    },
  });
  await github({
    token,
    url: `${base}/git/refs`,
    method: "POST",
    body: { ref: `refs/heads/${params.head}`, sha: checkedSha(created.sha) },
  });
  let answered = false;
  try {
    const pull = await githubJson<{ number: number; html_url: string }>({
      token,
      url: `${base}/pulls`,
      method: "POST",
      body: {
        title: params.title,
        body: params.body,
        head: params.head,
        base: branch,
      },
      errors: (response) => {
        answered = true;
        return githubPolicyChangeErrors(response);
      },
    });
    return { number: pull.number, url: pull.html_url };
  } catch (error) {
    // Without GitHub's answer the pull request may have opened all the same.
    const opened = answered
      ? null
      : await openPullFor({
          token,
          base,
          repo: source.repo,
          head: params.head,
        });
    if (opened) return opened;
    // A lookup that failed too leaves the branch: it may hold a pull request.
    if (opened === null) await deleteBranch({ token, base, head: params.head });
    throw error;
  }
}

/**
 * The open pull request from `head`, null when there is none, or undefined
 * when GitHub could not say.
 */
async function openPullFor(params: {
  token: string;
  base: string;
  repo: string;
  head: string;
}): Promise<
  { number: number; url: string; headSha?: string } | null | undefined
> {
  const owner = params.repo.slice(0, params.repo.indexOf("/"));
  try {
    const pulls = await github<
      Array<{ number?: number; html_url?: string; head?: { sha?: string } }>
    >({
      token: params.token,
      url: `${params.base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${params.head}`)}`,
    });
    const pull = pulls[0];
    return pull?.number && pull.html_url
      ? {
          number: pull.number,
          url: pull.html_url,
          ...(typeof pull.head?.sha === "string"
            ? { headSha: pull.head.sha }
            : {}),
        }
      : null;
  } catch (err) {
    logger.warn({ err }, "OpenAPPA could not look for a rules pull request");
    return undefined;
  }
}

/** Remove a rules branch whose pull request did not open; a failure is logged. */
async function deleteBranch(params: {
  token: string;
  base: string;
  head: string;
}) {
  const response = await githubFetch({
    url: `${params.base}/git/refs/heads/${params.head}`,
    token: params.token,
    method: "DELETE",
  }).catch(() => null);
  if (!response?.ok)
    logger.warn(
      { status: response?.status, head: params.head },
      "OpenAPPA could not delete a rules branch whose pull request did not open",
    );
}

async function githubWriter(
  source: Pick<
    Source,
    "organizationId" | "repo" | "githubPatId" | "githubAppConfigId"
  >,
  /** What the job needs besides writing contents and pull requests. */
  more: { checks?: "read" } = {},
) {
  const { token, api } = await resolveOpenAppaGithubAccess(source, {
    contents: "write",
    pull_requests: "write",
    ...more,
  });
  if (!token)
    throw new ApiError(
      409,
      "The policy repository is read without a credential, so no pull request can be opened. An administrator connects a GitHub App in Git sync.",
    );
  return { token, api };
}

function checkedSha(sha: unknown): string {
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha))
    throw new ApiError(502, "GitHub returned an invalid object");
  return sha;
}

async function github<T = unknown>(params: {
  token: string;
  url: string;
  method?: "GET" | "POST" | "PATCH";
  body?: object;
  signal?: AbortSignal;
}): Promise<T> {
  return githubJson<T>({ ...params, errors: githubPolicyChangeErrors });
}
