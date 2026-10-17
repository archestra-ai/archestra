import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { searchMcpRegistryMock, sdkCalls } = vi.hoisted(() => ({
  searchMcpRegistryMock: vi.fn(),
  sdkCalls: [] as string[],
}));

// Every SDK call is recorded; only the page's search answers.
vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  const sdk = new Proxy(actual.archestraApiSdk, {
    get(target, name: string) {
      if (name === "searchMcpRegistry") return searchMcpRegistryMock;
      const original = target[name as keyof typeof target];
      if (typeof original !== "function") return original;
      return () => {
        sdkCalls.push(name);
        return new Promise(() => {});
      };
    },
  });
  return { ...actual, archestraApiSdk: sdk };
});

const { requestCookies, requestHeaders } = vi.hoisted(() => ({
  requestCookies: new Map<string, string>(),
  // A full page load, as the proxy marks it.
  requestHeaders: new Map<string, string>([
    ["x-archestra-shell-seed", "/mcp/registry"],
  ]),
}));
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => requestHeaders.get(name) ?? null,
  }),
  cookies: async () => ({
    get: (name: string) =>
      requestCookies.has(name)
        ? { name, value: requestCookies.get(name) }
        : undefined,
  }),
}));

vi.mock("@/lib/utils/server", () => ({
  getServerApiHeaders: async () => ({ Cookie: "session=1" }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/mcp/registry",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { ArchestraQueryClientProvider } from "@/app/_parts/query-client-provider";
import { WithAuthCheck } from "@/app/_parts/with-auth-check";
import { WithPagePermissions } from "@/app/_parts/with-page-permissions";
import type { ShellSeed } from "@/lib/auth/shell-seed.server";
import McpRegistryPage from "./page";

const rows = Array.from({ length: 10 }, (_, i) => ({
  id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
  name: `seeded-server-${i}`,
  serverType: "remote",
  multitenant: false,
  scope: "org",
  authorId: null,
  description: null,
  labels: [],
  teams: [],
  environmentId: null,
  toolCount: 0,
  skillCount: 0,
  providesUi: false,
  providesSkills: false,
  catalogReinstallRequired: false,
  dynamicConnectionMcpServerId: null,
  icon: null,
  iconUrl: null,
  alertMutes: [],
  effectiveActions: ["read"],
  imageApprovalRequired: false,
  bindsCredential: false,
  enterpriseManaged: false,
  docsUrl: null,
  install: {
    visibleCount: 0,
    installedForViewer: false,
    primaryServerId: null,
  },
}));

const shellSeed: ShellSeed = {
  session: {
    user: { id: "u1", email: "admin@example.com", name: "Admin" },
    session: { activeOrganizationId: "org-1", userId: "u1" },
  },
  bootstrap: {
    permissions: { mcpRegistry: ["read"], mcpServerInstallation: ["read"] },
    scopedCapabilities: [],
    config: { features: {} },
    organization: null,
  } as unknown as ShellSeed["bootstrap"],
  queries: [],
};

async function renderDocument(seed: ShellSeed | null) {
  const page = await McpRegistryPage({ searchParams: Promise.resolve({}) });
  return renderToString(
    <ArchestraQueryClientProvider shellSeed={seed}>
      <WithAuthCheck>
        <WithPagePermissions>{page}</WithPagePermissions>
      </WithAuthCheck>
    </ArchestraQueryClientProvider>,
  );
}

describe("registry page server render", () => {
  beforeEach(() => {
    sdkCalls.length = 0;
    requestCookies.clear();
    searchMcpRegistryMock.mockResolvedValue({
      data: {
        data: rows,
        pagination: { total: 40, limit: 10, currentPage: 1, totalPages: 4 },
        selectableTotal: 0,
        installs: [],
        attentionTiers: [[], []],
      },
    });
  });

  it("puts the first page's rows in the HTML when the shell is resolved on the server", async () => {
    const html = await renderDocument(shellSeed);

    const body = html.split("<tbody")[1]?.split("</tbody>")[0] ?? "";
    expect(body.match(/<tr/g)?.length).toBe(10);
    for (const row of rows) expect(html).toContain(row.name);
  });

  it("renders the same holding state as before for a visitor the server could not sign in", async () => {
    const html = await renderDocument(null);

    expect(html).not.toContain("<tbody");
    expect(html).not.toContain(rows[0].name);
  });

  it("renders the saved card view on the server when the cookie says cards", async () => {
    requestCookies.set("archestra-mcp-registry-view", "cards");

    const html = await renderDocument(shellSeed);

    expect(html).not.toContain("<tbody");
    for (const row of rows) expect(html).toContain(row.name);
  });
});
