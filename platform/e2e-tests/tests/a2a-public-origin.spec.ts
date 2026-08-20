import { expect } from "@playwright/test";
import { UI_BASE_URL } from "../consts";
import { test } from "./api-fixtures";

/**
 * A2A lives under /v2, and the standard deployment terminates its public
 * ingress on the Next.js frontend, which reverse-proxies API paths to the
 * backend. A path missing from that rewrite list gets no rewrite at all: Next
 * answers it from the app router, so a JSON-RPC client receives the HTML 404
 * page instead of a response it can parse.
 *
 * These assertions deliberately go through the frontend origin rather than the
 * backend one. Only the two processes together can show the routing is intact,
 * which is why this is not a backend route test.
 */
test.describe("A2A over the public origin", () => {
  test("serves JSON, not the frontend's HTML shell", async ({
    request,
    createAgent,
    deleteAgent,
    makeApiRequest,
  }) => {
    const agentResponse = await createAgent(
      request,
      `A2A Public Origin ${Date.now()}`,
      "personal",
    );
    const agent = await agentResponse.json();

    try {
      const tokensResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/tokens",
      });
      const { tokens } = await tokensResponse.json();
      const orgToken = tokens.find(
        (token: { isOrganizationToken: boolean }) => token.isOrganizationToken,
      );
      const tokenValueResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/tokens/${orgToken.id}/value`,
      });
      const { value: archestraToken } = await tokenValueResponse.json();

      // The AgentCard is what an A2A SDK fetches first, so it is the first
      // thing a broken /v2 route breaks.
      const card = await request.get(
        `${UI_BASE_URL}/v2/a2a/${agent.id}/.well-known/agent-card.json`,
        { headers: { Authorization: `Bearer ${archestraToken}` } },
      );

      expect(card.status()).toBe(200);
      expect(card.headers()["content-type"]).toContain("application/json");

      // The card tells clients where to dial. Behind the frontend proxy the
      // backend's own Host header is the in-cluster address, which no external
      // client can reach — the card has to name the origin the caller used.
      const body = await card.json();
      expect(body.supportedInterfaces[0].url).toBe(
        `${UI_BASE_URL}/v2/a2a/${agent.id}`,
      );

      // And the JSON-RPC entry point itself answers in JSON-RPC. An
      // unauthenticated call is enough: the HTML 404 has no envelope at all.
      const rpc = await request.post(`${UI_BASE_URL}/v2/a2a/${agent.id}`, {
        headers: { "Content-Type": "application/json" },
        data: { jsonrpc: "2.0", id: 1, method: "ListTasks", params: {} },
      });

      expect(rpc.headers()["content-type"]).toContain("application/json");
      expect(await rpc.json()).toMatchObject({ jsonrpc: "2.0", id: 1 });
    } finally {
      await deleteAgent(request, agent.id);
    }
  });
});
