import { HttpResponse, http } from "msw";
import { describe, expect, test } from "@/test";
import {
  JIRA_TEST_SITE,
  seedJiraConfig,
  useJiraRouteTest,
} from "./chatops-jira.test-helpers";

describe("Jira ChatOps projects", () => {
  const { ctx, server } = useJiraRouteTest();

  test("lists only projects returned for the connected bot credential", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    const saved = await seedJiraConfig(ctx.organizationId, agent.id);
    server.use(
      http.get(`${JIRA_TEST_SITE}/rest/api/3/project/search`, () =>
        HttpResponse.json({
          isLast: true,
          startAt: 0,
          maxResults: 50,
          total: 1,
          values: [{ id: "10001", key: "DEMO", name: "Demo project" }],
        }),
      ),
    );
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/chatops/jira/bots/${saved.bots[0].id}/projects`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: "10001", key: "DEMO", name: "Demo project" },
    ]);
    expect(response.body).not.toContain(saved.bots[0].apiToken);
  });
});
