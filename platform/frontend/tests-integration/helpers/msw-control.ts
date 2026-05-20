import type { APIRequestContext, Page } from "@playwright/test";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export type HandlerOverride = {
  method: HttpMethod;
  url: string;
  status?: number;
  body?: unknown;
  once?: boolean;
};

export class MswControl {
  private readonly endpoint: string;

  constructor(
    private readonly request: APIRequestContext,
    private readonly page: Page,
    baseURL: string,
  ) {
    this.endpoint = `${baseURL}/internal-test/msw-handlers`;
  }

  async use(override: HandlerOverride): Promise<void> {
    const res = await this.request.post(this.endpoint, { data: override });
    if (!res.ok()) {
      throw new Error(
        `MswControl.use failed (status ${res.status()}): ${await res.text()}`,
      );
    }
    await this.syncBrowser();
  }

  /**
   * Fetch the list of API requests the Node MSW server saw without a matching
   * handler since the last reset. The fixture uses this to fail the test if
   * any SSR fetch escaped MSW coverage.
   */
  async getUnhandled(): Promise<string[]> {
    const res = await this.request.get(this.endpoint);
    if (!res.ok()) return [];
    const data = (await res.json()) as { unhandledRequests?: string[] };
    return data.unhandledRequests ?? [];
  }

  async reset(): Promise<void> {
    const res = await this.request.delete(this.endpoint);
    if (!res.ok()) {
      throw new Error(
        `MswControl.reset failed (status ${res.status()}): ${await res.text()}`,
      );
    }
    await this.syncBrowser();
  }

  // Push the latest registry state into the browser worker by invoking the
  // sync entrypoint MswInit installs on `window`. Best effort: if the page
  // has not navigated yet (window function not installed), the worker will
  // pick up the registry on its initial replay at startup.
  private async syncBrowser(): Promise<void> {
    try {
      await this.page.evaluate(
        async () => await window.__archestraSyncMswOverrides?.(),
      );
    } catch {
      // No active page context — nothing to sync.
    }
  }
}
