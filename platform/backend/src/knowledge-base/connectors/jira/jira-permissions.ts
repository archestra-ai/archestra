import type { Version2Client, Version3Client } from "jira.js";
import type pino from "pino";

/**
 * Per-document permission payload built by the Jira connector for
 * documents synced under `auto-sync-permissions` visibility.
 */
export interface JiraDocumentPermissions {
  users: string[];
  groups: string[];
}

interface ProjectPermissionEntry {
  /** accountId -> displayName (when available, used as fallback search query). */
  users: Map<string, string | undefined>;
  groups: Set<string>;
}

/**
 * Resolves the set of Atlassian users and groups that can read each Jira
 * project, caching the result for the duration of a single sync run.
 *
 * Atlassian Cloud does not expose a single "who can browse this issue"
 * endpoint, so we approximate it by combining the actors of every project
 * role attached to the project. Issue-level security levels are intentionally
 * not consulted here — they are a documented follow-up.
 *
 * Email resolution may fail for accounts whose profile email is hidden by
 * Atlassian's privacy settings; such users are dropped from the resulting
 * ACL with a debug log so administrators can investigate.
 */
export class JiraPermissionResolver {
  private readonly client: Version2Client | Version3Client;
  private readonly log: pino.Logger;
  private readonly isCloud: boolean;
  private readonly projectCache = new Map<
    string,
    Promise<ProjectPermissionEntry | null>
  >();
  private readonly emailCache = new Map<string, Promise<string | null>>();

  constructor(params: {
    client: Version2Client | Version3Client;
    log: pino.Logger;
    isCloud: boolean;
  }) {
    this.client = params.client;
    this.log = params.log;
    this.isCloud = params.isCloud;
  }

  async resolveForIssue(params: {
    projectKey: string | undefined;
  }): Promise<JiraDocumentPermissions | undefined> {
    const projectKey = params.projectKey?.trim();
    if (!projectKey) {
      return undefined;
    }

    const projectEntry = await this.getProjectPermissions(projectKey);
    if (!projectEntry) {
      return undefined;
    }

    const emails = await this.resolveEmails(projectEntry.users);

    return {
      users: emails,
      groups: [...projectEntry.groups],
    };
  }

  private getProjectPermissions(
    projectKey: string,
  ): Promise<ProjectPermissionEntry | null> {
    const cached = this.projectCache.get(projectKey);
    if (cached) return cached;

    const pending = this.fetchProjectPermissions(projectKey);
    this.projectCache.set(projectKey, pending);
    return pending;
  }

  private async fetchProjectPermissions(
    projectKey: string,
  ): Promise<ProjectPermissionEntry | null> {
    try {
      const roles = await this.fetchProjectRoles(projectKey);
      const users = new Map<string, string | undefined>();
      const groups = new Set<string>();

      for (const roleId of roles) {
        const role = await this.fetchProjectRole(projectKey, roleId);
        if (!role) continue;
        for (const actor of role.actors ?? []) {
          collectActor(actor, users, groups);
        }
      }

      return { users, groups };
    } catch (error) {
      this.log.warn(
        {
          projectKey,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to resolve Jira project permissions; documents in this project will be inaccessible",
      );
      return null;
    }
  }

  private async fetchProjectRoles(projectKey: string): Promise<number[]> {
    const response = (await this.client.projectRoles.getProjectRoles({
      projectIdOrKey: projectKey,
    })) as Record<string, string> | undefined;

    if (!response) return [];

    const roleIds: number[] = [];
    for (const url of Object.values(response)) {
      const match = /\/role\/(\d+)$/.exec(url);
      if (match) {
        roleIds.push(Number(match[1]));
      }
    }
    return roleIds;
  }

  private async fetchProjectRole(
    projectKey: string,
    roleId: number,
  ): Promise<{ actors?: unknown[] } | null> {
    try {
      const response = (await this.client.projectRoles.getProjectRole({
        projectIdOrKey: projectKey,
        id: roleId,
      })) as { actors?: unknown[] } | undefined;
      return response ?? null;
    } catch (error) {
      this.log.debug(
        {
          projectKey,
          roleId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to fetch Jira project role actors",
      );
      return null;
    }
  }

  private async resolveEmails(
    users: Map<string, string | undefined>,
  ): Promise<string[]> {
    if (users.size === 0) return [];

    const results = await Promise.all(
      [...users.entries()].map(([accountId, displayName]) =>
        this.resolveEmail(accountId, displayName),
      ),
    );
    const out: string[] = [];
    const seen = new Set<string>();
    for (const email of results) {
      if (!email) continue;
      const normalized = email.trim().toLowerCase();
      if (normalized.length === 0 || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  }

  private resolveEmail(
    accountId: string,
    displayName: string | undefined,
  ): Promise<string | null> {
    const cached = this.emailCache.get(accountId);
    if (cached) return cached;
    const pending = this.fetchEmail(accountId, displayName);
    this.emailCache.set(accountId, pending);
    return pending;
  }

  private async fetchEmail(
    accountId: string,
    displayName: string | undefined,
  ): Promise<string | null> {
    // Atlassian Cloud's lookup-by-accountId endpoints (`/user`, `/user/bulk`,
    // `/user/search?accountId=X`) stopped returning email addresses for
    // GDPR reasons even when profile visibility is "Anyone". The text-based
    // `/user/search?query=<name>` endpoint still returns emails, so we use
    // the actor's displayName from the project role as the search query
    // and pick the result whose accountId matches.
    if (this.isCloud) {
      const email = await this.fetchEmailViaTextSearch({
        accountId,
        query: displayName,
      });
      if (email) return email;
      return await this.fetchEmailViaUserEndpoint(accountId);
    }
    return await this.fetchEmailViaUserEndpoint(accountId);
  }

  private async fetchEmailViaTextSearch(params: {
    accountId: string;
    query: string | undefined;
  }): Promise<string | null> {
    const query = params.query?.trim();
    if (!query) return null;

    try {
      const userSearchApi = (
        this.client as unknown as {
          userSearch?: {
            findUsers: (p: Record<string, string>) => Promise<unknown>;
          };
        }
      ).userSearch;
      let response: unknown;
      if (userSearchApi?.findUsers) {
        response = await userSearchApi.findUsers({ query });
      } else {
        const sendRequest = (
          this.client as unknown as {
            sendRequest: (
              req: Record<string, unknown>,
              cb?: unknown,
            ) => Promise<unknown>;
          }
        ).sendRequest;
        response = await sendRequest(
          {
            url: "/rest/api/3/user/search",
            method: "GET",
            params: { query },
          },
          undefined,
        );
      }
      if (!Array.isArray(response)) return null;
      const match = response.find(
        (u): u is { accountId?: string; emailAddress?: string } =>
          Boolean(u) &&
          typeof u === "object" &&
          (u as { accountId?: string }).accountId === params.accountId,
      );
      const email = match?.emailAddress;
      return typeof email === "string" && email.length > 0 ? email : null;
    } catch (error) {
      this.log.debug(
        {
          accountId: params.accountId,
          query,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to resolve Jira accountId via /user/search?query=",
      );
      return null;
    }
  }

  private async fetchEmailViaUserEndpoint(
    accountId: string,
  ): Promise<string | null> {
    try {
      const params: Record<string, string> = this.isCloud
        ? { accountId }
        : { username: accountId };
      const usersApi = this.client.users as {
        getUser: (p: Record<string, string>) => Promise<unknown>;
      };
      const user = await usersApi.getUser(params);
      const email = (user as { emailAddress?: string } | undefined)
        ?.emailAddress;
      return typeof email === "string" && email.length > 0 ? email : null;
    } catch (error) {
      this.log.debug(
        {
          accountId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to resolve Jira accountId via /user",
      );
      return null;
    }
  }
}

function collectActor(
  actor: unknown,
  users: Map<string, string | undefined>,
  groups: Set<string>,
): void {
  if (!actor || typeof actor !== "object") return;
  const a = actor as Record<string, unknown>;
  const user = a.actorUser as Record<string, unknown> | undefined;
  if (user && typeof user.accountId === "string" && user.accountId.length > 0) {
    // The actor object carries `displayName` at the top level (e.g. "user1");
    // the nested `actorUser` only has the accountId.
    const existing = users.get(user.accountId);
    if (!existing) {
      const displayName =
        typeof a.displayName === "string" && a.displayName.length > 0
          ? a.displayName
          : undefined;
      users.set(user.accountId, displayName);
    }
  }
  const group = a.actorGroup as Record<string, unknown> | undefined;
  if (group) {
    const name =
      (typeof group.name === "string" && group.name) ||
      (typeof group.displayName === "string" && group.displayName) ||
      null;
    if (name) groups.add(name);
  }
}
