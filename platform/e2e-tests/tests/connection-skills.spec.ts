import type { APIResponse, Response } from "@playwright/test";
import { UI_BASE_URL } from "../consts";
import { expect, test } from "../fixtures";

test("connection loads skills without treating the proxy as a skill agent", async ({
  page,
  goToPage,
  makeRandomString,
}) => {
  const skillName = makeRandomString(8, "connection-skill").toLowerCase();
  const skillResponse = await page.request.post(`${UI_BASE_URL}/api/skills`, {
    data: {
      scope: "org",
      content: `---\nname: ${skillName}\ndescription: Review a client connection.\n---\nReview the client connection settings.`,
    },
  });
  await expectOk(skillResponse);
  const skill = await skillResponse.json();
  const agentIds: string[] = [];
  const failedSkillRequests: string[] = [];
  page.on("response", (response) => {
    if (
      response.url().includes("/api/") &&
      response.url().includes("skill") &&
      !response.ok()
    ) {
      failedSkillRequests.push(`${response.status()} ${response.url()}`);
    }
  });

  try {
    const proxyResponse = await page.request.get(
      `${UI_BASE_URL}/api/llm-proxy`,
    );
    await expectOk(proxyResponse);
    const proxy = await proxyResponse.json();
    const rejected = await page.request.get(`${UI_BASE_URL}/api/skills`, {
      params: { forAgentId: proxy.id },
    });
    expect(rejected.status()).toBe(400);
    expect((await rejected.json()).error.message).toBe(
      "This agent type does not expose skills",
    );

    const catalogResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/skills",
    );
    await goToPage(page, "/connection?clientId=claude-desktop");
    const catalog = await catalogResponse;
    await expectOk(catalog);
    expect((await catalog.json()).data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: skill.id })]),
    );
    await expect(page.getByText(skillName, { exact: false })).toBeVisible();
    await expect(page.getByText("Setup command ready")).toBeVisible();
    await expect(
      page.getByText("This agent type does not expose skills"),
    ).toHaveCount(0);

    for (const agentType of ["agent", "mcp_gateway"] as const) {
      const created = await page.request.post(`${UI_BASE_URL}/api/agents`, {
        data: {
          name: `${skillName}-${agentType}`,
          agentType,
          scope: "org",
          teams: [],
        },
      });
      await expectOk(created);
      const agent = await created.json();
      agentIds.push(agent.id);
      if (agentType === "mcp_gateway") {
        await expectOk(
          await page.request.put(
            `${UI_BASE_URL}/api/agents/${agent.id}/skills`,
            {
              data: { accessAllSkills: true, skillIds: [] },
            },
          ),
        );
      }
      const supported = await page.request.get(`${UI_BASE_URL}/api/skills`, {
        params: { forAgentId: agent.id },
      });
      await expectOk(supported);
      expect((await supported.json()).data).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: skill.id })]),
      );

      const family = agentType === "agent" ? "/agents" : "/mcp/gateways";
      const section = agentType === "agent" ? "tools" : "settings";
      await goToPage(page, `${family}/${agent.id}?section=${section}`);
      const viewSkills = page.getByRole("button", {
        name: /View (all.*skills|1 skill)/i,
      });
      await expect(viewSkills).toBeVisible();
      await viewSkills.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText(skillName, { exact: true })).toBeVisible();
      await expect(
        page.getByText("This agent type does not expose skills"),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
    }

    await goToPage(page, "/llm/proxy");
    await expect(
      page.getByRole("heading", { name: "LLM Proxy", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("This agent type does not expose skills"),
    ).toHaveCount(0);
    expect(failedSkillRequests).toEqual([]);
  } finally {
    for (const agentId of agentIds) {
      await expectOk(
        await page.request.delete(`${UI_BASE_URL}/api/agents/${agentId}`),
      );
    }
    await expectOk(
      await page.request.delete(`${UI_BASE_URL}/api/skills/${skill.id}`),
    );
  }
});

async function expectOk(response: APIResponse | Response): Promise<void> {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(
    true,
  );
}
