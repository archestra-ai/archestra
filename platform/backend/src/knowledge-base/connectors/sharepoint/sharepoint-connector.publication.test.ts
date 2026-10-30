// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMswServer } from "@/test/msw";
import type { ConnectorSyncBatch, SharePointConfig } from "@/types";
import { SharePointConnector } from "./sharepoint-connector";

// Replace only the identity-provider boundary; Graph requests use the real SDK.
vi.mock("@azure/identity", () => ({
  ClientSecretCredential: class {
    async getToken() {
      return { token: "test-token", expiresOnTimestamp: Date.now() + 3600000 };
    }
  },
}));

const graph = "https://graph.microsoft.com/v1.0";
const config = {
  type: "sharepoint" as const,
  tenantId: "test-tenant",
  siteUrl: "https://tenant.sharepoint.com",
  driveIds: ["drive-1"],
  recursive: false,
};
const credentials = { email: "test-client", apiToken: "test-secret" };
const states = ["published", "draft", "checkout", "future", undefined] as const;
const pages = states.map((level, index) => ({
  id: String(index),
  name: `page-${index}.aspx`,
  title: `Page ${index}`,
  lastModifiedDateTime: "2026-09-01T00:00:00Z",
  publishingState: level
    ? { level, versionId: level === "published" ? "1.0" : "1.1" }
    : undefined,
}));
describe("SharePoint page publication selection", () => {
  const server = useMswServer();
  let requestedPages: string[];

  beforeEach(() => {
    requestedPages = [];
    server.use(
      http.get(`${graph}/sites/tenant.sharepoint.com`, () =>
        HttpResponse.json({ id: "site-1" }),
      ),
      http.get(`${graph}/drives/drive-1/root/children`, () =>
        HttpResponse.json({ value: [] }),
      ),
      http.get(`${graph}/sites/site-1/pages`, ({ request }) => {
        const url = new URL(request.url);
        // Return only selected properties, like Graph: omitting publishingState
        // from $select must cause the filtering behavior tests to fail.
        const value = pages.map((page) =>
          Object.fromEntries(
            Object.entries(page).filter(([key]) =>
              url.searchParams.get("$select")?.split(",").includes(key),
            ),
          ),
        );
        return HttpResponse.json({
          value: value.slice(0, 2),
          "@odata.nextLink": `${graph}/remaining-pages`,
        });
      }),
      http.get(`${graph}/remaining-pages`, () =>
        HttpResponse.json({ value: pages.slice(2) }),
      ),
      http.get(
        `${graph}/sites/site-1/pages/:id/microsoft.graph.sitePage`,
        ({ params, request }) => {
          requestedPages.push(String(params.id));
          expect(new URL(request.url).searchParams.get("$expand")).toBe(
            "canvasLayout",
          );
          return HttpResponse.json({
            ...pages[Number(params.id)],
            canvasLayout: {
              horizontalSections: [
                {
                  columns: [
                    { webparts: [{ innerHtml: "<p>Horizontal text</p>" }] },
                  ],
                },
              ],
              verticalSection: {
                webparts: [{ innerHtml: "<p>Vertical text</p>" }],
              },
            },
          });
        },
      ),
      http.get(
        `${graph}/sites/site-1/pages/:id/microsoft.graph.sitePage/webParts`,
        ({ params }) => {
          requestedPages.push(String(params.id));
          return HttpResponse.json({
            value: [{ innerHtml: "<p>Page text</p>" }],
          });
        },
      ),
    );
  });

  it.each([
    ["published", ["page-0"]],
    ["draft", ["page-1"]],
    ["both", pages.map((page) => `page-${page.id}`)],
    [undefined, pages.map((page) => `page-${page.id}`)],
  ] as const)("syncs and counts %s pages across pagination", async (status, expected) => {
    const connector = new SharePointConnector(0);
    const selectedConfig = { ...config, pagePublicationStatus: status };
    const batches = await collect({ connector, config: selectedConfig });
    expect(
      batches.flatMap((batch) => batch.documents.map((doc) => doc.id)),
    ).toEqual(expected);
    expect(requestedPages).toEqual(
      expected.map((id) => id.replace("page-", "")),
    );
    expect(
      await connector.estimateTotalItems({
        config: selectedConfig,
        credentials,
        checkpoint: null,
      }),
    ).toBe(expected.length);
    if (status === "published" || status === "draft") {
      expect(batches.flatMap((batch) => batch.documents)[0].content).toContain(
        "Horizontal text\n\nVertical text",
      );
      expect(batches.flatMap((batch) => batch.reconcileScopes ?? [])).toEqual(
        pages
          .filter((page) => !expected.some((id) => id === `page-${page.id}`))
          .map((page) => ({
            metadataFilter: { siteId: "site-1", pageId: page.id },
            seenSourceIds: [],
          })),
      );
    } else {
      expect(batches.flatMap((batch) => batch.reconcileScopes ?? [])).toEqual(
        [],
      );
    }
  });

  it("retires excluded pages even outside the incremental window", async () => {
    const batches = await collect({
      connector: new SharePointConnector(0),
      config: { ...config, pagePublicationStatus: "published" },
      checkpoint: {
        type: "sharepoint",
        lastSyncedAt: "2026-09-10T00:00:00.000Z",
      },
    });
    expect(batches.flatMap((batch) => batch.documents)).toEqual([]);
    expect(requestedPages).toEqual([]);
    expect(
      batches
        .flatMap((batch) => batch.reconcileScopes ?? [])
        .map((scope) => scope.metadataFilter.pageId),
    ).toEqual(["1", "2", "3", "4"]);
    expect(batches.at(-1)?.checkpoint.lastSyncedAt).toBe(
      "2026-09-10T00:00:00.000Z",
    );
  });

  it("does not index a draft created between listing and content retrieval", async () => {
    server.use(
      http.get(`${graph}/sites/site-1/pages/0/microsoft.graph.sitePage`, () =>
        HttpResponse.json({
          ...pages[0],
          publishingState: { level: "draft", versionId: "1.1" },
          canvasLayout: {
            verticalSection: { webparts: [{ innerHtml: "Unpublished edits" }] },
          },
        }),
      ),
    );
    const batches = await collect({
      connector: new SharePointConnector(0),
      config: { ...config, pagePublicationStatus: "published" },
    });
    expect(batches.flatMap((batch) => batch.documents)).toEqual([]);
    expect(
      batches
        .flatMap((batch) => batch.reconcileScopes ?? [])
        .map((scope) => scope.metadataFilter.pageId),
    ).toContain("0");
  });

  it("preserves the indexed copy on a transient content fetch failure", async () => {
    server.use(
      http.get(
        `${graph}/sites/site-1/pages/0/microsoft.graph.sitePage`,
        () => new HttpResponse(null, { status: 403 }),
      ),
    );
    const batches = await collect({
      connector: new SharePointConnector(0),
      config: { ...config, pagePublicationStatus: "published" },
    });
    expect(batches.flatMap((batch) => batch.documents)).toEqual([]);
    expect(batches.flatMap((batch) => batch.failures ?? [])).toEqual([
      expect.objectContaining({ itemId: "0", itemUnavailable: true }),
    ]);
    expect(
      batches
        .flatMap((batch) => batch.reconcileScopes ?? [])
        .map((scope) => scope.metadataFilter.pageId),
    ).not.toContain("0");
  });

  it("does not fetch or reconcile pages when Include Pages is disabled", async () => {
    const connector = new SharePointConnector(0);
    const selectedConfig = {
      ...config,
      includePages: false,
      pagePublicationStatus: "published" as const,
    };
    server.use(
      http.get(`${graph}/sites/site-1/pages`, () => {
        throw new Error("Pages are disabled");
      }),
    );
    const batches = await collect({ connector, config: selectedConfig });
    expect(batches.flatMap((batch) => batch.reconcileScopes ?? [])).toEqual([]);
    expect(
      await connector.estimateTotalItems({
        config: selectedConfig,
        credentials,
        checkpoint: null,
      }),
    ).toBe(0);
  });
});

async function collect(params: {
  connector: SharePointConnector;
  config: SharePointConfig;
  checkpoint?: Record<string, unknown>;
}) {
  const batches: ConnectorSyncBatch[] = [];
  for await (const batch of params.connector.sync({
    config: params.config,
    credentials,
    checkpoint: params.checkpoint ?? null,
  }))
    batches.push(batch);
  return batches;
}
