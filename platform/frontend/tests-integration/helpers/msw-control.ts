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
    // Push the new override straight into the browser worker as a single
    // worker.use(handler) call. Deliberately not a reset+replay — that would
    // resurrect `once: true` handlers MSW had already consumed.
    await this.applyToBrowser(override);
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
    await this.resetBrowser();
  }

  // Push a single override into the browser worker. No-op if the page has
  // not navigated yet — the initial registry replay at MswInit startup will
  // pick it up when the page eventually loads.
  private async applyToBrowser(override: HandlerOverride): Promise<void> {
    try {
      await this.page.evaluate(
        async (o) => await window.__archestraApplyMswOverride?.(o),
        override,
      );
    } catch {
      // No active page context.
    }
  }

  private async resetBrowser(): Promise<void> {
    try {
      await this.page.evaluate(() => window.__archestraResetMswOverrides?.());
    } catch {
      // No active page context.
    }
  }
}
