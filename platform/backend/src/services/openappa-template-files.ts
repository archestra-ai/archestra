import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import { gitClient } from "@/git-hosts/git-access";
import logger from "@/logging";
import type OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { OPENAPPA_TEMPLATE } from "@/openappa/template.generated";
import { readResponseBodyWithLimit } from "@/plugins/bounded-response";
import {
  githubFetch,
  githubJson,
  githubPolicyChangeErrors,
  withGithubMessage,
} from "@/services/openappa-github";
import {
  MissingGithubPermission,
  resolveOpenAppaGithubAccess,
  resolveOpenAppaGitlabAccess,
} from "@/services/openappa-github-access";
import { openappaGitlab } from "@/services/openappa-gitlab";
import { ApiError } from "@/types";
import type { AppaTemplateFiles } from "@/types/openappa-github-sync";

/**
 * The files Archestra keeps beside the policy in its repository, from the
 * bundled template: the validation workflow, the Dependabot configuration and
 * the READMEs. The policy itself is never one of them.
 *
 * A repository created from an older template keeps its files until someone
 * updates them, and a workflow that validates the wrong way breaks every
 * later pull request. So each sync compares the files at the accepted commit
 * with the template this version bundles, and proposes what differs as a
 * pull request (a merge request on GitLab). Setup writes the current files
 * into a repository it seeds or proposes to, so a new source starts current.
 */

/** The policy file and validations folder the template's files are written for. */
const TEMPLATE_POLICY_PATH = "appa.toml";
const TEMPLATE_VALIDATION_DIRECTORY = "traces";

/** The branch the GitHub pull request comes from, fixed so one is open at most. */
const TEMPLATE_BRANCH = "archestra/openappa-template";

const PULL_TITLE = "Update the OpenAPPA policy repository files";

/** How long the last comparison stands, past any sync interval. */
const STATE_TTL = 30 * 24 * 60 * 60_000;

/** The most bytes of one repository file compared; the template's are far smaller. */
const FILE_MAX_BYTES = 256 * 1024;

type SetupFile = { path: string; content: string };

/** The template's files beside the policy, the policy's own file left out. */
function templateFiles(): SetupFile[] {
  return OPENAPPA_TEMPLATE.files
    .filter((file) => file.path !== TEMPLATE_POLICY_PATH)
    .map((file) => ({ path: file.path, content: file.content }));
}

/**
 * Whether the template's files apply to a source: its policy is `appa.toml`
 * at the repository root and its validations live in `traces/`, which is
 * what the template's workflow validates.
 */
export function templateFilesApply(source: {
  path: string | null;
  validationDirectory?: string | null;
}): boolean {
  return (
    source.path === TEMPLATE_POLICY_PATH &&
    (source.validationDirectory || TEMPLATE_VALIDATION_DIRECTORY) ===
      TEMPLATE_VALIDATION_DIRECTORY
  );
}

/**
 * The template files a repository lacks or holds differently, read with
 * `read`: what setup writes along with the policy, so the repository starts
 * current. A read that fails throws: "unreadable" must not pass for
 * "current".
 */
export async function driftedTemplateFiles(
  read: (path: string) => Promise<string | null>,
): Promise<SetupFile[]> {
  const drifted: SetupFile[] = [];
  for (const file of templateFiles())
    if ((await read(file.path)) !== file.content) drifted.push(file);
  return drifted;
}

/** The last comparison for an organization's source, as the settings show it. */
export async function getTemplateFilesState(
  organizationId: string,
): Promise<AppaTemplateFiles | undefined> {
  try {
    return await cacheManager.get<AppaTemplateFiles>(stateKey(organizationId));
  } catch (error) {
    logger.warn(
      { organizationId, error },
      "OpenAPPA could not read the template files' state",
    );
    return undefined;
  }
}

/** Forget the comparison: the source moved, so the next sync compares anew. */
export async function forgetTemplateFilesState(organizationId: string) {
  await cacheManager
    .delete(stateKey(organizationId))
    .catch((error) =>
      logger.warn(
        { organizationId, error },
        "OpenAPPA could not forget the template files' state",
      ),
    );
}

type SyncRow = NonNullable<
  Awaited<ReturnType<typeof OpenAppaGithubSyncModel.find>>
>;

/**
 * Compare the repository's files at the accepted commit with the template
 * and bring them in line: open the pull request that updates them when none
 * waits, leave the one that does, close one left from an earlier template.
 * Never fails the sync: the outcome is recorded for the settings page.
 */
export async function maintainTemplateFiles(
  row: SyncRow & { repo: string; path: string; sourceCommit: string },
): Promise<AppaTemplateFiles> {
  const previous = await getTemplateFilesState(row.organizationId);
  let state: AppaTemplateFiles;
  try {
    state = await compareAndPropose(row, previous);
  } catch (error) {
    logger.warn(
      { organizationId: row.organizationId, error },
      "OpenAPPA could not compare the policy repository's files with the template",
    );
    // The pull request already open stays known: the next sync updates or
    // closes it, and the settings keep pointing at it meanwhile.
    state = {
      templateCommit: OPENAPPA_TEMPLATE.commit,
      state: "unavailable",
      paths: previous?.paths ?? [],
      ...(previous?.pull
        ? { pull: previous.pull, withheld: previous.withheld ?? [] }
        : {}),
      detail:
        error instanceof ApiError
          ? error.message
          : "Could not reach the policy repository",
      checkedAt: new Date().toISOString(),
    };
  }
  await cacheManager
    .set(stateKey(row.organizationId), state, STATE_TTL)
    .catch((error) =>
      logger.warn(
        { organizationId: row.organizationId, error },
        "OpenAPPA could not record the template files' state",
      ),
    );
  return state;
}

async function compareAndPropose(
  row: SyncRow & { repo: string; path: string; sourceCommit: string },
  previous: AppaTemplateFiles | undefined,
): Promise<AppaTemplateFiles> {
  const checkedAt = new Date().toISOString();
  const templateCommit = OPENAPPA_TEMPLATE.commit;
  const suite = await OpenAppaPolicyTestsModel.find(row.organizationId);
  if (!templateFilesApply({ ...row, validationDirectory: suite?.directory }))
    return {
      templateCommit,
      state: "not_applicable",
      paths: [],
      detail: `The template's files are written for ${TEMPLATE_POLICY_PATH} at the repository root with validations in ${TEMPLATE_VALIDATION_DIRECTORY}/.`,
      checkedAt,
    };
  const host = await repositoryHost(row);
  if (!host)
    return {
      templateCommit,
      state: "unavailable",
      paths: [],
      detail:
        "The policy repository is read without a credential that can open pull requests.",
      checkedAt,
    };
  const drifted = await driftedTemplateFiles((path) =>
    host.read(row.sourceCommit, path),
  );
  const paths = drifted.map((file) => file.path).sort();
  // Our earlier pull request, if it still waits.
  const open = previous?.pull
    ? await host.openPull(previous.pull.number)
    : null;
  if (drifted.length === 0) {
    // Brought current another way: the pull request has nothing left to do.
    if (open) await host.closePull(open.number, "the files are current now");
    return { templateCommit, state: "current", paths: [], checkedAt };
  }
  const workflows = paths.filter(isWorkflowPath);
  // A workflow file takes a permission the App may lack: asked first, so the
  // proposal carries what GitHub accepts and names what waits for the grant.
  let missing = workflows.length
    ? await host.missingWorkflowsPermission()
    : null;
  let withheld = missing ? workflows : [];
  // The waiting pull request stands while it carries everything it can: the
  // same template, the same files, and none it left out that may go in now.
  const leftOut = open ? (previous?.withheld ?? []) : [];
  if (
    open &&
    previous?.templateCommit === templateCommit &&
    sameList(previous.paths, paths) &&
    leftOut.every((path) => withheld.includes(path))
  )
    return {
      templateCommit,
      state: "pull_open",
      paths,
      withheld: leftOut,
      detail: leftOut.length ? (missing ?? previous.detail) : undefined,
      pull: open,
      checkedAt,
    };
  const propose = async (left: string[]) => {
    const files = drifted.filter((file) => !left.includes(file.path));
    if (files.length === 0) return null;
    return host.propose({
      base: row.sourceCommit,
      files,
      title: PULL_TITLE,
      body: pullBody(
        files.map((file) => file.path),
        left,
        missing,
      ),
      replacing: open,
    });
  };
  let proposed = await propose(withheld);
  // GitHub judged the permission on the write: propose the rest without the
  // workflow, which waits for the grant.
  if (proposed && "needsPermission" in proposed && withheld.length === 0) {
    missing = proposed.needsPermission;
    withheld = workflows;
    proposed = await propose(withheld);
  }
  if (!proposed) {
    // Only what the App may not write differs: a waiting pull request
    // carries files that are current by now.
    if (open)
      await host.closePull(open.number, "the files it carries are current now");
    return {
      templateCommit,
      state: "needs_permission",
      paths,
      withheld: workflows,
      detail: missing ?? undefined,
      checkedAt,
    };
  }
  if ("needsPermission" in proposed)
    return {
      templateCommit,
      state: "needs_permission",
      paths,
      withheld: workflows,
      detail: proposed.needsPermission,
      ...(open ? { pull: open } : {}),
      checkedAt,
    };
  // A host that opened another one (GitLab opens each on its own branch):
  // the earlier one gives way only now that its successor is open.
  if (open && open.number !== proposed.number)
    await host.closePull(
      open.number,
      `#${proposed.number} replaces it with a newer version of the files`,
    );
  logger.info(
    {
      organizationId: row.organizationId,
      repo: row.repo,
      paths,
      withheld,
      pull: proposed.number,
      updated: open?.number === proposed.number,
    },
    "OpenAPPA proposed the template's files to the policy repository",
  );
  return {
    templateCommit,
    state: "pull_open",
    paths,
    withheld,
    detail: missing ?? undefined,
    pull: proposed,
    checkedAt,
  };
}

function isWorkflowPath(path: string): boolean {
  return path.startsWith(".github/workflows/");
}

function sameList(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function pullBody(
  paths: string[],
  withheld: string[],
  missing: string | null,
): string {
  const named = (list: string[]) =>
    list.map((path) => `\`${path}\``).join(", ");
  return [
    `This version of the platform ships newer versions of the files beside the policy: ${named(paths)}. They validate pull requests against the policy and describe the repository; the policy itself does not change.`,
    "",
    `Review and merge it to keep the repository's checks working. ${OPENAPPA_TEMPLATE.repo}@${OPENAPPA_TEMPLATE.commit.slice(0, 7)} is the template these files come from.`,
    ...(withheld.length
      ? [
          "",
          `Left out for now: ${named(withheld)}. ${missing ?? "The GitHub App may not write workflows."} A later sync proposes it once the permission is granted.`,
        ]
      : []),
  ].join("\n");
}

/** The pull request Archestra opened, by its number. */
type Pull = { number: number; url: string };

type RepositoryHost = {
  /** One file's text at a commit; null when the commit has no such file. */
  read(commit: string, path: string): Promise<string | null>;
  /** The pull request by number while it is open; null once merged or closed. */
  openPull(number: number): Promise<Pull | null>;
  /** Close a pull request of ours, saying why; a failure is logged. */
  closePull(number: number, why: string): Promise<void>;
  /** Why a workflow file cannot be written, or null when it can. */
  missingWorkflowsPermission(): Promise<string | null>;
  /**
   * One commit on a branch from `base`, then the pull request into the
   * synced branch. With `replacing`, a host that can moves that pull
   * request's branch to the commit instead, so the same one carries it.
   */
  propose(params: {
    base: string;
    files: SetupFile[];
    title: string;
    body: string;
    replacing: Pull | null;
  }): Promise<Pull | { needsPermission: string }>;
};

async function repositoryHost(
  row: SyncRow & { repo: string; path: string },
): Promise<RepositoryHost | null> {
  return row.gitlabTokenId
    ? gitlabHost({ ...row, gitlabTokenId: row.gitlabTokenId })
    : githubHost(row);
}

async function githubHost(
  row: SyncRow & { repo: string; path: string },
): Promise<RepositoryHost | null> {
  const permissions = {
    contents: "write",
    pull_requests: "write",
  } as const;
  const { token, api } = await resolveOpenAppaGithubAccess(row, permissions);
  if (!token) return null;
  const base = `${api}/repos/${row.repo}`;
  const encode = (path: string) =>
    path.split("/").map(encodeURIComponent).join("/");
  const call = <T>(params: {
    token: string;
    url: string;
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: object;
  }) => githubJson<T>({ ...params, errors: githubPolicyChangeErrors });
  const github = <T>(params: {
    url: string;
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: object;
  }) => call<T>({ ...params, token });
  // GitHub refuses a tree, commit or branch that writes a workflow file from
  // a token minted without Workflows, whatever the App was granted: such a
  // proposal is written with a token that carries it.
  const workflowsAccess = () =>
    resolveOpenAppaGithubAccess(row, { ...permissions, workflows: "write" });
  return {
    async read(commit, path) {
      const response = await githubFetch({
        url: `${base}/contents/${encode(path)}?ref=${commit}`,
        token,
        accept: "application/vnd.github.raw+json",
      });
      if (response.status === 404) return null;
      if (!response.ok)
        throw new ApiError(
          502,
          `GitHub returned HTTP ${response.status} for ${path}. Check repository access.`,
        );
      const bytes = await readResponseBodyWithLimit(response, FILE_MAX_BYTES);
      // Larger than any template file: it differs.
      return bytes ? bytes.toString("utf8") : "";
    },
    async openPull(number) {
      const pull = await github<{
        number?: number;
        html_url?: string;
        state?: string;
      }>({ url: `${base}/pulls/${number}` });
      return pull.state === "open" && pull.number && pull.html_url
        ? { number: pull.number, url: pull.html_url }
        : null;
    },
    async closePull(number, why) {
      try {
        await github({
          url: `${base}/pulls/${number}`,
          method: "PATCH",
          body: {
            state: "closed",
            body: `Closed: ${why}.`,
          },
        });
      } catch (error) {
        logger.warn(
          { repo: row.repo, number, error },
          "OpenAPPA could not close an earlier template files pull request",
        );
      }
    },
    async missingWorkflowsPermission() {
      try {
        await workflowsAccess();
        return null;
      } catch (error) {
        if (error instanceof MissingGithubPermission) return error.message;
        throw error;
      }
    },
    async propose(params) {
      let writer = token;
      if (params.files.some((file) => isWorkflowPath(file.path))) {
        try {
          writer = (await workflowsAccess()).token ?? token;
        } catch (error) {
          if (error instanceof MissingGithubPermission)
            return { needsPermission: error.message };
          throw error;
        }
      }
      const write = <T>(request: {
        url: string;
        method?: "GET" | "POST" | "PATCH" | "DELETE";
        body?: object;
      }) => call<T>({ ...request, token: writer });
      const branch =
        row.ref ??
        (await github<{ default_branch: string }>({ url: base }))
          .default_branch;
      const parent = await github<{ tree?: { sha?: string } }>({
        url: `${base}/git/commits/${params.base}`,
      });
      const tree = await write<{ sha: string }>({
        url: `${base}/git/trees`,
        method: "POST",
        body: {
          base_tree: parent.tree?.sha,
          tree: params.files.map((file) => ({
            path: file.path,
            mode: "100644",
            type: "blob",
            content: file.content,
          })),
        },
      });
      const commit = await write<{ sha: string }>({
        url: `${base}/git/commits`,
        method: "POST",
        // No author or committer: GitHub signs the commit for the App only then.
        body: {
          message: params.title,
          tree: tree.sha,
          parents: [params.base],
        },
      });
      // Writing a workflow file takes the App's Workflows permission; GitHub
      // refuses the ref that would carry one without it.
      let workflowRefused: string | null = null;
      const errors = withGithubMessage((status, message) => {
        if (/workflow/i.test(message ?? ""))
          // An access token has no App to grant it: its scope is the fix.
          workflowRefused = row.githubAppConfigId
            ? new MissingGithubPermission(row.repo, {
                workflows: "write",
              }).message
            : "The access token lacks the workflow scope, so it cannot write the validation workflow. Give the token that scope.";
        return new ApiError(
          502,
          `GitHub returned HTTP ${status} while proposing the repository files.`,
        );
      });
      try {
        if (params.replacing) {
          // The waiting pull request's branch moves to the new commit: the
          // same pull request carries the files, with its text brought along.
          await githubJson({
            url: `${base}/git/refs/heads/${TEMPLATE_BRANCH}`,
            token: writer,
            method: "PATCH",
            body: { sha: commit.sha, force: true },
            errors,
          });
          await github({
            url: `${base}/pulls/${params.replacing.number}`,
            method: "PATCH",
            body: { title: params.title, body: params.body },
          });
          return params.replacing;
        }
        // A branch left by an earlier, closed pull request would refuse the new ref.
        await githubFetch({
          url: `${base}/git/refs/heads/${TEMPLATE_BRANCH}`,
          token: writer,
          method: "DELETE",
        }).catch(() => null);
        await githubJson({
          url: `${base}/git/refs`,
          token: writer,
          method: "POST",
          body: { ref: `refs/heads/${TEMPLATE_BRANCH}`, sha: commit.sha },
          errors,
        });
      } catch (error) {
        if (workflowRefused) return { needsPermission: workflowRefused };
        throw error;
      }
      const pull = await github<{ number: number; html_url: string }>({
        url: `${base}/pulls`,
        method: "POST",
        body: {
          title: params.title,
          body: params.body,
          head: TEMPLATE_BRANCH,
          base: branch,
        },
      });
      return { number: pull.number, url: pull.html_url };
    },
  };
}

async function gitlabHost(
  row: SyncRow & { repo: string; path: string; gitlabTokenId: string },
): Promise<RepositoryHost> {
  const access = await resolveOpenAppaGitlabAccess({
    organizationId: row.organizationId,
    gitlabTokenId: row.gitlabTokenId,
  });
  const client = gitClient(access);
  return {
    async read(commit, path) {
      const bytes = await client.readFile({
        repo: row.repo,
        ref: commit,
        path,
        maxBytes: FILE_MAX_BYTES,
      });
      return bytes ? bytes.toString("utf8") : null;
    },
    async openPull(number) {
      const request = await client.gitlabMergeRequest(row.repo, number);
      return request.state === "open"
        ? { number: request.iid, url: request.webUrl }
        : null;
    },
    async closePull(number, why) {
      try {
        await client.json(
          `${client.repoApi(row.repo)}/merge_requests/${number}`,
          {
            method: "PUT",
            body: { state_event: "close", description: `Closed: ${why}.` },
          },
        );
      } catch (error) {
        logger.warn(
          { repo: row.repo, number, error },
          "OpenAPPA could not close an earlier template files merge request",
        );
      }
    },
    // A token with the api scope writes any file.
    async missingWorkflowsPermission() {
      return null;
    },
    async propose(params) {
      const branch =
        row.ref ??
        (await openappaGitlab.defaultBranch({ access, repo: row.repo }));
      const opened = await openappaGitlab.proposeChange({
        access,
        repo: row.repo,
        branch,
        baseSha: params.base,
        title: params.title,
        summary: params.body,
        upsert: params.files,
        delete: [],
      });
      return { number: opened.iid, url: opened.webUrl };
    },
  };
}

function stateKey(organizationId: string): AllowedCacheKey {
  return `${CacheKey.OpenAppaPolicyCheck}-template-${organizationId}`;
}
