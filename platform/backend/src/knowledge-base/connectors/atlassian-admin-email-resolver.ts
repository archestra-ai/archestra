// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import type pino from "pino";
import { LRUCacheManager } from "@/cache-manager";
import { extractErrorMessage, REQUEST_TIMEOUT_MS } from "./base-connector";

const ATLASSIAN_ADMIN_API_BASE_URL = "https://api.atlassian.com";
const DIRECTORY_SEARCH_PAGE_SIZE = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30000;
/** Distinct accounts the per-account profile fallback memoizes per pass. */
const PROFILE_EMAIL_CACHE_MAX_SIZE = 10_000;
/**
 * Accounts the bulk directory load will hold in memory before it stops reading.
 *
 * The load is an OPTIMIZATION — it trades one pass over the org's directories
 * for the per-account profile lookups it saves — and it is bounded only by the
 * size of the customer's Atlassian org, which the connector does not control.
 * Past this many accounts the map stops growing and the accounts beyond it
 * resolve through `resolveViaManagedProfile` instead: correct, just a request
 * each. So the cap costs requests, never correctness, which is why it can sit
 * generously high (a couple of hundred thousand entries is tens of megabytes)
 * rather than being an operator knob to tune.
 */
const MAX_DIRECTORY_EMAILS = 250_000;

/**
 * Resolves Atlassian Cloud accountIds to emails through the admin APIs when the
 * product REST APIs hide them.
 *
 * Atlassian Cloud hides a user's email from the Jira/Confluence product APIs
 * unless that user set their profile email visibility to "Anyone" — and an
 * admin credential does NOT unlock it there (Atlassian closed AX-207,
 * https://jira.atlassian.com/browse/AX-207, as "Not a bug", pointing callers at
 * the Organizations API instead). The sanctioned bypass is exactly that: an
 * org-admin API key against the Organizations/Directory API returns every
 * MANAGED account's email regardless of profile visibility. This resolver
 * implements it via the v2 directory endpoints (the v1 admin user APIs are
 * being deprecated), with the per-account user-management profile endpoint as a
 * second chance for managed accounts missing from the directory listing.
 *
 * The bearer key is the credential's dedicated `adminApiKey` (an
 * organization admin API key, ideally created WITHOUT scopes — the org-list
 * and directory users/search endpoints are absent from Atlassian's scopes
 * table, and unlisted endpoints require an unscoped key). It is a separate
 * credential field because the product REST APIs reject org-admin API keys
 * just as the admin APIs reject user API tokens — one value cannot serve
 * both. Connectors fall back to the product apiToken as a long-shot bearer
 * when no admin key is configured; when the key in use cannot call the admin
 * APIs (insufficient scope, or a plain user token) the first admin call
 * fails 401/403 and the resolver disables itself for the pass — behavior
 * then stays exactly what it was without this fallback (hidden emails record
 * as unresolved, fail-closed). Transient failures (429/5xx/network) are
 * retried with backoff instead, and never disable the resolver.
 */
export class AtlassianAdminEmailResolver {
  private readonly apiKey: string;
  private readonly log: pino.Logger;
  private readonly rateLimit: () => Promise<void>;

  /**
   * accountId → email bulk-loaded from the org directories; null until loaded.
   * Deliberately a plain Map, not an LRU cache: it is the complete directory
   * snapshot (every entry is authoritative for the whole pass), bounded by the
   * org's directory size, and freed with this per-pass instance. Evicting
   * entries would turn "not in the directory" lookups into false negatives'
   * worth of per-account API calls.
   */
  private directoryEmails: Map<string, string> | null = null;
  /** Per-account results of the manage/profile fallback (null = tried, no email). */
  private readonly profileEmails = new LRUCacheManager<string | null>({
    maxSize: PROFILE_EMAIL_CACHE_MAX_SIZE,
  });
  /** Set when the credential cannot call the admin APIs — every lookup no-ops. */
  private disabled = false;

  constructor(params: {
    apiKey: string;
    log: pino.Logger;
    rateLimit: () => Promise<void>;
  }) {
    this.apiKey = params.apiKey;
    this.log = params.log;
    this.rateLimit = params.rateLimit;
  }

  /**
   * Resolve one accountId to an email, or null when the admin APIs are
   * unavailable to this credential or genuinely have no email for the account.
   */
  async resolveEmail(accountId: string): Promise<string | null> {
    if (this.disabled || !this.apiKey) return null;

    if (this.directoryEmails === null) {
      await this.loadDirectoryEmails();
      if (this.disabled) return null;
    }
    const fromDirectory = this.directoryEmails?.get(accountId);
    if (fromDirectory) return fromDirectory;

    return this.resolveViaManagedProfile(accountId);
  }

  // ===== Private methods =====

  /**
   * Bulk-load accountId → email for every managed account visible to the API
   * key: orgs → directories → directory users search (all cursor-paginated).
   * One load per pass; most members need it (email is hidden by default for
   * ALL Atlassian account types), so a bulk load beats per-account calls.
   */
  private async loadDirectoryEmails(): Promise<void> {
    const emails = new Map<string, string>();
    let capped = false;
    try {
      const orgIds: string[] = [];
      for await (const org of this.paginate("/admin/v1/orgs")) {
        if (org?.id) orgIds.push(String(org.id));
      }

      outer: for (const orgId of orgIds) {
        const directoryIds: string[] = [];
        for await (const directory of this.paginate(
          `/admin/v2/orgs/${encodeURIComponent(orgId)}/directories`,
        )) {
          if (directory?.directoryId) {
            directoryIds.push(String(directory.directoryId));
          }
        }

        for (const directoryId of directoryIds) {
          for await (const user of this.paginateUsersSearch({
            orgId,
            directoryId,
          })) {
            if (user?.accountId && user?.email) {
              emails.set(String(user.accountId), String(user.email));
            }
            if (emails.size >= MAX_DIRECTORY_EMAILS) {
              capped = true;
              break outer;
            }
          }
        }
      }
    } catch (error) {
      // A rejected credential (plain user API token) disables the fallback for
      // the pass — never fails the sync. Anything else (429/5xx/network that
      // survived request()'s retries, unexpected shape) only gives up on the
      // bulk directory listing; the per-account profile fallback stays live.
      if (isCredentialRejection(error)) {
        this.disabled = true;
        this.directoryEmails = new Map();
        this.log.info(
          { error: extractErrorMessage(error) },
          "Atlassian admin APIs rejected the credential; hidden emails stay unresolved (use an org-admin API key as the connector credential to enable the fallback)",
        );
        return;
      }
      this.directoryEmails = new Map();
      this.log.warn(
        { error: extractErrorMessage(error) },
        "Atlassian admin directory bulk load failed after retries; falling back to per-account profile lookups for this pass",
      );
      return;
    }

    this.directoryEmails = emails;
    if (capped) {
      this.log.warn(
        { managedAccounts: emails.size, cap: MAX_DIRECTORY_EMAILS },
        "Atlassian org directory exceeds the accounts this pass will hold in memory; the rest resolve one request at a time through the per-account profile endpoint (slower, same result)",
      );
      return;
    }
    this.log.debug(
      { managedAccounts: emails.size },
      "Loaded Atlassian org directory emails",
    );
  }

  /**
   * Per-account fallback for managed accounts the directory listing missed:
   * GET /users/{account_id}/manage/profile returns the email unconditionally
   * for accounts the API key can manage (403/404 otherwise).
   */
  private async resolveViaManagedProfile(
    accountId: string,
  ): Promise<string | null> {
    const cached = this.profileEmails.get(accountId);
    if (cached !== undefined) return cached;

    let email: string | null = null;
    try {
      await this.rateLimit();
      const response = await this.request(
        `/users/${encodeURIComponent(accountId)}/manage/profile`,
      );
      email = response?.account?.email ?? null;
    } catch (error) {
      this.log.debug(
        { accountId, error: extractErrorMessage(error) },
        "Atlassian managed-profile email lookup failed",
      );
    }
    this.profileEmails.set(accountId, email);
    return email;
  }

  /** Cursor-paginated GET over an admin endpoint returning `{ data, links }`. */
  // biome-ignore lint/suspicious/noExplicitAny: admin API response shapes
  private async *paginate(path: string): AsyncGenerator<any> {
    let cursor: string | null = null;
    for (;;) {
      await this.rateLimit();
      const url = cursor
        ? `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`
        : path;
      const response = await this.request(url);
      // biome-ignore lint/suspicious/noExplicitAny: admin API response shapes
      const data: any[] = response?.data ?? [];
      for (const item of data) yield item;
      cursor = extractCursor(response?.links?.next);
      if (!cursor || data.length === 0) break;
    }
  }

  /** Cursor-paginated POST /users/search over one org directory. */
  private async *paginateUsersSearch(params: {
    orgId: string;
    directoryId: string;
    // biome-ignore lint/suspicious/noExplicitAny: admin API response shapes
  }): AsyncGenerator<any> {
    const path = `/admin/v2/orgs/${encodeURIComponent(params.orgId)}/directories/${encodeURIComponent(params.directoryId)}/users/search`;
    let cursor: string | null = null;
    for (;;) {
      await this.rateLimit();
      const response = await this.request(path, {
        method: "POST",
        body: {
          limit: DIRECTORY_SEARCH_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        },
      });
      // biome-ignore lint/suspicious/noExplicitAny: admin API response shapes
      const data: any[] = response?.data ?? [];
      for (const item of data) yield item;
      cursor = extractCursor(response?.links?.next);
      if (!cursor || data.length === 0) break;
    }
  }

  /**
   * One admin-API call with a per-attempt timeout. 429 (honoring Retry-After)
   * and 5xx/network errors retry with capped exponential backoff; other HTTP
   * failures throw an AdminApiError carrying the status so the caller can tell
   * a rejected credential (401/403) from a transient outage.
   */
  private async request(
    path: string,
    options?: { method?: string; body?: unknown },
    // biome-ignore lint/suspicious/noExplicitAny: admin API response shapes
  ): Promise<any> {
    const method = options?.method ?? "GET";
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${ATLASSIAN_ADMIN_API_BASE_URL}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
            ...(options?.body ? { "Content-Type": "application/json" } : {}),
          },
          ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        // Network error or per-attempt timeout — transient by nature.
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < MAX_RETRIES) {
          await sleep(backoffDelay(attempt));
          continue;
        }
        throw new AdminApiError(
          `Atlassian admin API ${method} ${path} failed: ${lastError.message}`,
          null,
        );
      }

      if (response.ok) return response.json();

      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < MAX_RETRIES
      ) {
        await sleep(retryDelay(response, attempt));
        continue;
      }
      throw new AdminApiError(
        `Atlassian admin API ${method} ${path} failed: HTTP ${response.status}`,
        response.status,
      );
    }

    // Unreachable: every loop exit above returns or throws.
    throw lastError ?? new Error("Atlassian admin API request failed");
  }
}

// ===== Internal helpers =====

/** Admin-API failure carrying the HTTP status (null for network errors). */
class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

/** The credential itself cannot call the admin APIs (plain user API token). */
function isCredentialRejection(error: unknown): boolean {
  return (
    error instanceof AdminApiError &&
    (error.status === 401 || error.status === 403)
  );
}

/** Backoff for a 429, preferring the server's Retry-After over the schedule. */
function retryDelay(response: Response, attempt: number): number {
  const retryAfterSeconds = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, RETRY_MAX_DELAY_MS);
  }
  return backoffDelay(attempt);
}

function backoffDelay(attempt: number): number {
  const exponentialDelay = RETRY_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * 0.25 * exponentialDelay;
  return Math.min(exponentialDelay + jitter, RETRY_MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `links.next` is either a full URL or a bare cursor depending on the
 * endpoint generation; normalize to the cursor value.
 */
function extractCursor(next: unknown): string | null {
  if (!next || typeof next !== "string") return null;
  if (!next.includes("://") && !next.startsWith("/")) return next;
  try {
    const url = new URL(next, ATLASSIAN_ADMIN_API_BASE_URL);
    return url.searchParams.get("cursor");
  } catch {
    return null;
  }
}
