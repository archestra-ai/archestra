import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./api-fixtures";

const AUDIT_LOGS_PATH = "/api/audit-logs";

type AuditLogRow = {
  id: string;
  organizationId: string;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  priorState: Record<string, unknown> | null;
  postState: Record<string, unknown> | null;
  httpMethod: string | null;
  httpPath: string | null;
  httpRoute: string | null;
  httpStatus: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
};

type AuditLogsResponse = {
  data: AuditLogRow[];
  pagination: {
    currentPage: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
};

type MakeApiRequest = (args: {
  request: APIRequestContext;
  method: "get" | "post" | "put" | "patch" | "delete";
  urlSuffix: string;
  data?: unknown;
  ignoreStatusCheck?: boolean;
}) => Promise<{ status: () => number; json: () => Promise<unknown> }>;

async function fetchAuditLogs(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
  query: Record<string, string | number | undefined>,
): Promise<AuditLogsResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") {
      params.append(key, String(value));
    }
  }
  const suffix = `${AUDIT_LOGS_PATH}${params.size ? `?${params.toString()}` : ""}`;
  const response = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: suffix,
  });
  return (await response.json()) as AuditLogsResponse;
}

async function waitForAuditRow(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
  match: (row: AuditLogRow) => boolean,
  query: Record<string, string | number | undefined>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<AuditLogRow | undefined> {
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 500;
  for (let i = 0; i < attempts; i++) {
    const logs = await fetchAuditLogs(makeApiRequest, request, query);
    const found = logs.data.find(match);
    if (found) return found;
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return undefined;
}

test.describe("Audit log API", () => {
  test("records an agent create with priorState=null and a populated postState", async ({
    adminRequest,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    const agentName = `audit-create-${Date.now()}`;
    const created = await createAgent(adminRequest, agentName, "personal");
    const agent = (await created.json()) as { id: string; name: string };

    try {
      const row = await waitForAuditRow(
        makeApiRequest,
        adminRequest,
        (r) => r.resourceId === agent.id,
        { resourceType: "agent", action: "create", limit: 50 },
      );

      expect(row, "audit row for agent create not found").toBeDefined();
      expect(row?.action).toBe("create");
      expect(row?.resourceType).toBe("agent");
      expect(row?.httpMethod).toBe("POST");
      expect(row?.httpStatus).toBeGreaterThanOrEqual(200);
      expect(row?.httpStatus).toBeLessThan(300);
      expect(row?.priorState).toBeNull();
      expect(row?.postState).not.toBeNull();
      expect(row?.postState).toMatchObject({ id: agent.id });
      // Denormalized actor snapshot must be present.
      expect(row?.actorEmail).toBeTruthy();
    } finally {
      await deleteAgent(adminRequest, agent.id);
    }
  });

  test("records an agent update with priorState and postState differing on the changed field", async ({
    adminRequest,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    const initialName = `audit-update-initial-${Date.now()}`;
    const renamed = `audit-update-renamed-${Date.now()}`;
    const created = await createAgent(adminRequest, initialName, "personal");
    const agent = (await created.json()) as { id: string };

    try {
      await makeApiRequest({
        request: adminRequest,
        method: "patch",
        urlSuffix: `/api/agents/${agent.id}`,
        data: { name: renamed },
      });

      const row = await waitForAuditRow(
        makeApiRequest,
        adminRequest,
        (r) => r.resourceId === agent.id,
        { resourceType: "agent", action: "update", limit: 50 },
      );

      expect(row, "audit row for agent update not found").toBeDefined();
      expect(row?.action).toBe("update");
      expect(row?.priorState).not.toBeNull();
      expect(row?.postState).not.toBeNull();
      expect((row?.priorState as { name?: string })?.name).toBe(initialName);
      expect((row?.postState as { name?: string })?.name).toBe(renamed);
    } finally {
      await deleteAgent(adminRequest, agent.id);
    }
  });

  test("records an agent delete with priorState populated and postState null", async ({
    adminRequest,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    const name = `audit-delete-${Date.now()}`;
    const created = await createAgent(adminRequest, name, "personal");
    const agent = (await created.json()) as { id: string };

    await deleteAgent(adminRequest, agent.id);

    const row = await waitForAuditRow(
      makeApiRequest,
      adminRequest,
      (r) => r.resourceId === agent.id,
      { resourceType: "agent", action: "delete", limit: 50 },
    );

    expect(row, "audit row for agent delete not found").toBeDefined();
    expect(row?.action).toBe("delete");
    expect(row?.priorState).not.toBeNull();
    expect((row?.priorState as { id?: string })?.id).toBe(agent.id);
    expect(row?.postState).toBeNull();
  });

  test("does not record a row for GET reads", async ({
    adminRequest,
    makeApiRequest,
  }) => {
    // Capture latest createdAt to compare before/after.
    const before = await fetchAuditLogs(makeApiRequest, adminRequest, {
      httpMethod: undefined,
      limit: 1,
    });
    const beforeCreatedAt = before.data[0]?.createdAt;

    // Read-only endpoint should never produce a row.
    await makeApiRequest({
      request: adminRequest,
      method: "get",
      urlSuffix: "/api/agents?limit=1",
    });

    // Small settle to give any (incorrect) async write a chance to land.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const after = await fetchAuditLogs(makeApiRequest, adminRequest, {
      limit: 5,
    });
    // No new row should have appeared above the prior latest.
    if (beforeCreatedAt) {
      const newer = after.data.filter(
        (r) => r.createdAt > beforeCreatedAt && r.httpMethod === "GET",
      );
      expect(newer).toHaveLength(0);
    } else {
      expect(after.data.every((r) => r.httpMethod !== "GET")).toBe(true);
    }
  });

  test("returns 403 to a member account", async ({
    memberRequest,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request: memberRequest,
      method: "get",
      urlSuffix: `${AUDIT_LOGS_PATH}?limit=1`,
      ignoreStatusCheck: true,
    });
    expect(response.status()).toBe(403);
  });

  test("returns 403 to an editor account", async ({
    editorRequest,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request: editorRequest,
      method: "get",
      urlSuffix: `${AUDIT_LOGS_PATH}?limit=1`,
      ignoreStatusCheck: true,
    });
    expect(response.status()).toBe(403);
  });

  test("rejects an invalid sortDirection with 400", async ({
    adminRequest,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request: adminRequest,
      method: "get",
      urlSuffix: `${AUDIT_LOGS_PATH}?sortDirection=banana`,
      ignoreStatusCheck: true,
    });
    expect(response.status()).toBe(400);
  });

  test("filters narrow results independently", async ({
    adminRequest,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    const name = `audit-filter-${Date.now()}`;
    const created = await createAgent(adminRequest, name, "personal");
    const agent = (await created.json()) as { id: string };

    try {
      const seeded = await waitForAuditRow(
        makeApiRequest,
        adminRequest,
        (r) => r.resourceId === agent.id,
        { resourceType: "agent", action: "create", limit: 50 },
      );
      expect(seeded).toBeDefined();

      const byResourceType = await fetchAuditLogs(
        makeApiRequest,
        adminRequest,
        { resourceType: "agent", limit: 100 },
      );
      expect(byResourceType.data.length).toBeGreaterThan(0);
      expect(byResourceType.data.every((r) => r.resourceType === "agent")).toBe(
        true,
      );

      const byAction = await fetchAuditLogs(makeApiRequest, adminRequest, {
        action: "create",
        limit: 100,
      });
      expect(byAction.data.every((r) => r.action === "create")).toBe(true);

      const bySearch = await fetchAuditLogs(makeApiRequest, adminRequest, {
        search: agent.id,
        limit: 100,
      });
      expect(bySearch.data.some((r) => r.resourceId === agent.id)).toBe(true);
    } finally {
      await deleteAgent(adminRequest, agent.id);
    }
  });
});
