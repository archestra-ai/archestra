import type { APIRequestContext } from "@playwright/test";
import { ARCHESTRA_URL } from "./env";

/**
 * A thin HTTP client over a Playwright request context. Seeding only uses the
 * public API, so it works against any instance — no database access.
 */
export class ArchestraApi {
  constructor(private readonly request: APIRequestContext) {}

  async signIn(email: string, password: string): Promise<boolean> {
    const response = await this.request.post(
      `${ARCHESTRA_URL}/api/auth/sign-in/email`,
      { data: { email, password }, headers: { Origin: ARCHESTRA_URL } },
    );
    return response.ok();
  }

  async signOut(): Promise<void> {
    await this.request.post(`${ARCHESTRA_URL}/api/auth/sign-out`, {
      headers: { Origin: ARCHESTRA_URL },
    });
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.send<T>("get", path);
  }

  post<T = unknown>(path: string, data?: unknown): Promise<T> {
    return this.send<T>("post", path, data);
  }

  patch<T = unknown>(path: string, data?: unknown): Promise<T> {
    return this.send<T>("patch", path, data);
  }

  put<T = unknown>(path: string, data?: unknown): Promise<T> {
    return this.send<T>("put", path, data);
  }

  /** Like `post`, but returns null instead of throwing on a non-2xx response. */
  async tryPost<T = unknown>(path: string, data?: unknown): Promise<T | null> {
    const response = await this.request.post(`${ARCHESTRA_URL}${path}`, {
      data,
      headers: { Origin: ARCHESTRA_URL },
    });
    return response.ok() ? ((await response.json()) as T) : null;
  }

  /**
   * Returns the existing item whose `name` matches, or creates it. Seeding is
   * additive and idempotent: re-running never duplicates or deletes anything.
   */
  async ensureNamed<T extends { id: string; name: string }>(params: {
    list: () => Promise<T[]>;
    name: string;
    create: () => Promise<T>;
  }): Promise<T> {
    const existing = (await params.list()).find(
      (item) => item.name === params.name,
    );
    return existing ?? params.create();
  }

  private async send<T>(
    method: "get" | "post" | "patch" | "put",
    path: string,
    data?: unknown,
  ): Promise<T> {
    const response = await this.request[method](`${ARCHESTRA_URL}${path}`, {
      data,
      headers: { Origin: ARCHESTRA_URL },
    });
    if (!response.ok()) {
      throw new Error(
        `${method.toUpperCase()} ${path} failed (${response.status()}): ${await response.text()}`,
      );
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/**
 * Unwraps a list response: a plain array, a paginated `{ data: [...] }`, or any
 * object whose list sits under a single array-valued field (`{ environments }`).
 */
export function items<T>(response: T[] | { data: T[] } | Record<string, unknown>): T[] {
  if (Array.isArray(response)) return response;
  const list = Object.values(response).find(Array.isArray);
  if (!list) throw new Error(`Expected a list response, got ${JSON.stringify(response).slice(0, 200)}`);
  return list as T[];
}
