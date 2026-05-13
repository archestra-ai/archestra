import type { ConfluenceClient } from "confluence.js";
import type pino from "pino";

export interface ConfluenceDocumentPermissions {
  users: string[];
  groups: string[];
}

interface SubjectSet {
  accountIds: Set<string>;
  groups: Set<string>;
}

/**
 * Resolves per-page ACL for Confluence content under `auto-sync-permissions`
 * visibility.
 *
 * Strategy:
 *   1. Pull the page-level read restrictions for the document. If any user
 *      or group is listed, that explicit allow-list becomes the ACL.
 *   2. Otherwise, fall back to the read permissions of the page's space.
 *      Space permissions are cached per sync run.
 *   3. Atlassian account IDs are resolved to email addresses via the user
 *      lookup endpoint. Emails hidden by Atlassian's privacy settings are
 *      dropped from the ACL with a debug log so admins can investigate.
 */
export class ConfluencePermissionResolver {
  private readonly client: ConfluenceClient;
  private readonly log: pino.Logger;
  private readonly isCloud: boolean;
  private readonly spaceCache = new Map<string, Promise<SubjectSet | null>>();
  private readonly emailCache = new Map<string, Promise<string | null>>();

  constructor(params: {
    client: ConfluenceClient;
    log: pino.Logger;
    isCloud: boolean;
  }) {
    this.client = params.client;
    this.log = params.log;
    this.isCloud = params.isCloud;
  }

  async resolveForPage(params: {
    pageId: string;
    spaceKey: string | undefined;
  }): Promise<ConfluenceDocumentPermissions | undefined> {
    const pageRestrictions = await this.fetchPageRestrictions(params.pageId);
    const subjects =
      pageRestrictions && hasAnySubject(pageRestrictions)
        ? pageRestrictions
        : params.spaceKey
          ? await this.getSpacePermissions(params.spaceKey)
          : null;

    if (!subjects || !hasAnySubject(subjects)) {
      return undefined;
    }

    const emails = await this.resolveEmails([...subjects.accountIds]);
    return {
      users: emails,
      groups: [...subjects.groups],
    };
  }

  private async fetchPageRestrictions(
    pageId: string,
  ): Promise<SubjectSet | null> {
    try {
      const response =
        (await this.client.contentRestrictions.getRestrictionsForOperation({
          id: pageId,
          operationKey: "read",
          expand: ["restrictions.user", "restrictions.group"],
          limit: 200,
        })) as unknown;
      return extractSubjectsFromRestriction(response);
    } catch (error) {
      this.log.debug(
        {
          pageId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to fetch Confluence page restrictions",
      );
      return null;
    }
  }

  private getSpacePermissions(spaceKey: string): Promise<SubjectSet | null> {
    const cached = this.spaceCache.get(spaceKey);
    if (cached) return cached;
    const pending = this.fetchSpacePermissions(spaceKey);
    this.spaceCache.set(spaceKey, pending);
    return pending;
  }

  private async fetchSpacePermissions(
    spaceKey: string,
  ): Promise<SubjectSet | null> {
    try {
      const response = (await this.client.sendRequest(
        {
          url: this.isCloud
            ? `/api/space/${encodeURIComponent(spaceKey)}`
            : `/api/space/${encodeURIComponent(spaceKey)}`,
          method: "GET",
          params: {
            expand: "permissions",
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK signature requires callback arg
        undefined as any,
      )) as unknown;

      return extractSubjectsFromSpace(response);
    } catch (error) {
      this.log.warn(
        {
          spaceKey,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to fetch Confluence space permissions; documents in this space may be inaccessible",
      );
      return null;
    }
  }

  private async resolveEmails(accountIds: string[]): Promise<string[]> {
    if (accountIds.length === 0) return [];

    const results = await Promise.all(
      accountIds.map((id) => this.resolveEmail(id)),
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

  private resolveEmail(accountId: string): Promise<string | null> {
    const cached = this.emailCache.get(accountId);
    if (cached) return cached;
    const pending = this.fetchEmail(accountId);
    this.emailCache.set(accountId, pending);
    return pending;
  }

  private async fetchEmail(accountId: string): Promise<string | null> {
    // Atlassian Cloud's `/api/user?accountId=X` endpoint stopped returning
    // emails even when profile visibility is "Anyone". The `/api/user/bulk`
    // endpoint still does, so try that first on Cloud before falling back
    // to the legacy single-user endpoint (which Server/DC still supports).
    if (this.isCloud) {
      const email = await this.fetchEmailViaBulk(accountId);
      if (email) return email;
    }
    return await this.fetchEmailViaUserEndpoint(accountId);
  }

  private async fetchEmailViaBulk(accountId: string): Promise<string | null> {
    try {
      const response = (await this.client.sendRequest(
        {
          url: "/api/user/bulk",
          method: "GET",
          params: { accountId },
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK signature requires callback arg
        undefined as any,
      )) as
        | { results?: Array<{ email?: string; emailAddress?: string }> }
        | undefined;

      const first = response?.results?.[0];
      const email = first?.email ?? first?.emailAddress;
      return typeof email === "string" && email.length > 0 ? email : null;
    } catch (error) {
      this.log.debug(
        {
          accountId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to resolve Confluence accountId via /user/bulk",
      );
      return null;
    }
  }

  private async fetchEmailViaUserEndpoint(
    accountId: string,
  ): Promise<string | null> {
    try {
      const response = (await this.client.sendRequest(
        {
          url: "/api/user",
          method: "GET",
          params: this.isCloud ? { accountId } : { key: accountId },
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK signature requires callback arg
        undefined as any,
      )) as { email?: string; emailAddress?: string } | undefined;

      const email = response?.email ?? response?.emailAddress;
      return typeof email === "string" && email.length > 0 ? email : null;
    } catch (error) {
      this.log.debug(
        {
          accountId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to resolve Confluence accountId via /api/user",
      );
      return null;
    }
  }
}

function hasAnySubject(set: SubjectSet): boolean {
  return set.accountIds.size > 0 || set.groups.size > 0;
}

function extractSubjectsFromRestriction(response: unknown): SubjectSet | null {
  if (!response || typeof response !== "object") return null;
  const r = response as Record<string, unknown>;
  const restrictions = r.restrictions as Record<string, unknown> | undefined;
  if (!restrictions) return null;

  const accountIds = new Set<string>();
  const groups = new Set<string>();

  const userResults = readResults(restrictions.user);
  for (const u of userResults) {
    const accountId =
      (typeof u.accountId === "string" && u.accountId) ||
      (typeof u.userKey === "string" && u.userKey) ||
      null;
    if (accountId) accountIds.add(accountId);
  }

  const groupResults = readResults(restrictions.group);
  for (const g of groupResults) {
    const name =
      (typeof g.name === "string" && g.name) ||
      (typeof g.displayName === "string" && g.displayName) ||
      null;
    if (name) groups.add(name);
  }

  return { accountIds, groups };
}

function extractSubjectsFromSpace(response: unknown): SubjectSet | null {
  if (!response || typeof response !== "object") return null;
  const r = response as Record<string, unknown>;
  const permissions = r.permissions;
  if (!Array.isArray(permissions)) return null;

  const accountIds = new Set<string>();
  const groups = new Set<string>();

  for (const raw of permissions) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const operation = p.operation as Record<string, unknown> | undefined;
    const operationKey =
      typeof operation?.operation === "string"
        ? operation.operation
        : typeof p.operationKey === "string"
          ? p.operationKey
          : null;
    if (operationKey !== "read") continue;

    const subjects = p.subjects as Record<string, unknown> | undefined;
    if (subjects) {
      const userResults = readResults(subjects.user);
      for (const u of userResults) {
        const accountId =
          (typeof u.accountId === "string" && u.accountId) ||
          (typeof u.userKey === "string" && u.userKey) ||
          null;
        if (accountId) accountIds.add(accountId);
      }
      const groupResults = readResults(subjects.group);
      for (const g of groupResults) {
        const name =
          (typeof g.name === "string" && g.name) ||
          (typeof g.displayName === "string" && g.displayName) ||
          null;
        if (name) groups.add(name);
      }
      continue;
    }

    // Server/DC shape: permission entries carry the subject inline.
    const userSubject = p.userSubject as Record<string, unknown> | undefined;
    if (userSubject) {
      const accountId =
        (typeof userSubject.accountId === "string" && userSubject.accountId) ||
        (typeof userSubject.userKey === "string" && userSubject.userKey) ||
        null;
      if (accountId) accountIds.add(accountId);
    }
    const groupSubject = p.groupSubject as Record<string, unknown> | undefined;
    if (groupSubject) {
      const name =
        (typeof groupSubject.name === "string" && groupSubject.name) || null;
      if (name) groups.add(name);
    }
  }

  return { accountIds, groups };
}

function readResults(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const v = value as Record<string, unknown>;
  const results = v.results;
  if (!Array.isArray(results)) return [];
  return results.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object",
  );
}
