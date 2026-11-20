import { makeAgent } from "../src/mocks/data/agents";
import { makeUserPermissions } from "../src/mocks/data/auth";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";
import { makeConversation } from "./helpers/chat-conversation";

test.use({ viewport: { width: 1280, height: 1300 } });

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} mode tool-call circles`, () => {
    test.use({ colorScheme });

    test("orders circles chronologically around narration, opens cards under their circles, and preserves 16px block gaps", async ({
      page,
      mswControl,
    }, testInfo) => {
      const key = makeLlmProviderApiKey({ provider: "openai" });
      const agent = makeAgent({ llmApiKeyId: key.id });
      const conversation = makeConversation({
        id: "20000000-0000-4000-8000-000000002079",
        agentId: agent.id,
        title: "Tool-call circle ordering",
        messageCount: 0,
      });

      const messages = [
        {
          id: "u1",
          role: "user",
          parts: [
            {
              type: "text",
              text: "Check my policy, preview an update, and check server info.",
            },
          ],
        },
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "tool-archestra__load_skill",
              toolCallId: "c1",
              state: "output-available",
              input: { name: "guardrails" },
              output: "loaded",
            },
            {
              type: "tool-archestra__get_guardrails_policy",
              toolCallId: "c2",
              state: "output-available",
              input: {},
              output: "policy loaded",
            },
            {
              type: "text",
              text: "I checked the current policy.",
            },
            {
              type: "tool-archestra__get_guardrails_validation",
              toolCallId: "c3",
              state: "output-available",
              input: {},
              output: "validation loaded",
            },
            {
              type: "text",
              text: "Here is the preview and approval request for the update.",
            },
            {
              type: "tool-archestra__preview_guardrails_policy_change",
              toolCallId: "c4",
              state: "output-available",
              input: {
                expectedRevision: 3,
                edits: [
                  { oldText: "old_rule = false", newText: "old_rule = true" },
                ],
              },
              output: {
                structuredContent: {
                  stage: "preview",
                  delivery: "revision",
                  path: "appa.toml",
                  before: "old_rule = false\n",
                  after: "old_rule = true\n",
                },
              },
            },
            {
              type: "tool-github__delete_branch",
              toolCallId: "c5",
              state: "approval-requested",
              input: { branch: "stale-policy-branch" },
              approval: { id: "apr-1" },
            },
            {
              type: "text",
              text: "One server needs fresh credentials before I continue.",
            },
            {
              type: "tool-id-jag_test__get_server_info",
              toolCallId: "c6",
              state: "output-available",
              input: {},
              output: {
                isError: true,
                _meta: {
                  archestraError: {
                    type: "auth_expired",
                    message:
                      'Expired or invalid authentication for "id-jag test".',
                    catalogId: "cat_abc",
                    catalogName: "id-jag test",
                    serverId: "srv_xyz",
                    reauthUrl:
                      "http://localhost:3000/mcp/registry?reauth=cat_abc&server=srv_xyz",
                  },
                },
              },
            },
            {
              type: "text",
              text: "Re-authenticate and let me know when you are ready.",
            },
          ],
        },
      ];

      await mswControl.registerMany([
        {
          method: "get",
          url: "/api/user/permissions",
          body: makeUserPermissions({
            chat: ["read", "create", "update", "delete", "full-view"],
          }),
        },
        { method: "get", url: "/api/agents/chat-roster", body: [agent] },
        { method: "get", url: `/api/agents/${agent.id}`, body: agent },
        { method: "get", url: "/api/agents/credential-readiness", body: [] },
        { method: "get", url: "/api/llm-provider-api-keys", body: [key] },
        {
          method: "get",
          url: "/api/llm-provider-api-keys/available",
          body: [key],
        },
        {
          method: "get",
          url: "/api/members/default-model",
          body: { modelId: null, chatApiKeyId: null },
        },
        { method: "get", url: "/api/chat/conversations", body: [conversation] },
        {
          method: "get",
          url: `/api/chat/conversations/${conversation.id}`,
          body: { ...conversation, messages },
        },
        {
          method: "get",
          url: `/api/chat/conversations/${conversation.id}/files`,
          body: [],
        },
        {
          method: "get",
          url: `/api/chat/conversations/${conversation.id}/share`,
          body: null,
        },
      ]);

      await page.goto(`/chat/${conversation.id}`);

      const skillPill = page.getByRole("status", { name: "guardrails" });
      const row1Circle = page.getByRole("button", {
        name: "get guardrails policy",
      });
      const text1 = page.getByText("I checked the current policy.", {
        exact: true,
      });
      const row2Circle = page.getByRole("button", {
        name: "get guardrails validation",
      });
      const text2 = page.getByText(
        "Here is the preview and approval request for the update.",
        { exact: true },
      );
      const previewCircle = page.getByRole("button", {
        name: "preview guardrails policy change",
      });
      const approvalCircle = page.getByRole("button", {
        name: "delete branch (approval required)",
      });
      const policyDiff = page.getByRole("region", {
        name: "Policy diff",
        exact: true,
      });
      const approveButton = page.getByRole("button", {
        name: "Approve",
        exact: true,
      });
      const text3 = page.getByText(
        "One server needs fresh credentials before I continue.",
        { exact: true },
      );
      const authCircle = page.getByRole("button", {
        name: "get server info (error)",
      });
      const reauthButton = page.getByRole("button", {
        name: "Re-authenticate",
        exact: true,
      });
      const text4 = page.getByText(
        "Re-authenticate and let me know when you are ready.",
        { exact: true },
      );

      await expect(skillPill).toBeVisible();
      await expect(row1Circle).toBeVisible();
      await expect(text1).toBeVisible();
      await expect(row2Circle).toBeVisible();
      await expect(text2).toBeVisible();
      await expect(previewCircle).toHaveAttribute("aria-expanded", "true");
      await expect(approvalCircle).toHaveAttribute("aria-expanded", "true");
      await expect(policyDiff).toBeVisible();
      await expect(approveButton).toBeVisible();
      await expect(text3).toBeVisible();
      await expect(authCircle).toHaveAttribute("aria-expanded", "false");
      await expect(reauthButton).toBeVisible();
      await expect(text4).toBeVisible();

      const previewCard = page
        .locator('[data-slot="collapsible"]')
        .filter({ has: policyDiff })
        .first();
      const approvalCard = page
        .locator('[data-slot="collapsible"]')
        .filter({ has: approveButton })
        .first();
      const authCard = reauthButton.locator(
        "xpath=ancestor::div[contains(@class,'rounded-xl')][1]",
      );
      const text1Bubble = text1.locator(
        "xpath=ancestor::div[contains(@class,'is-assistant')][1]",
      );
      const text2Bubble = text2.locator(
        "xpath=ancestor::div[contains(@class,'is-assistant')][1]",
      );
      const text3Bubble = text3.locator(
        "xpath=ancestor::div[contains(@class,'is-assistant')][1]",
      );
      const text4Bubble = text4.locator(
        "xpath=ancestor::div[contains(@class,'is-assistant')][1]",
      );

      // Measure all vertical positions and consecutive visible gaps in one frame.
      const geometry = await page.evaluate(
        (els) => {
          const rect = (el: Element | null) => {
            if (!el) throw new Error("Missing expected element");
            const r = el.getBoundingClientRect();
            return {
              top: Math.round(r.top),
              bottom: Math.round(r.bottom),
              height: Math.round(r.height),
            };
          };
          const b = {
            row1Circle: rect(els.row1Circle),
            text1: rect(els.text1Bubble),
            row2Circle: rect(els.row2Circle),
            text2: rect(els.text2Bubble),
            previewCircle: rect(els.previewCircle),
            previewCard: rect(els.previewCard),
            approvalCard: rect(els.approvalCard),
            text3: rect(els.text3Bubble),
            authCircle: rect(els.authCircle),
            authCard: rect(els.authCard),
            text4: rect(els.text4Bubble),
          };
          return {
            boxes: b,
            gaps: {
              row1ToText1: b.text1.top - b.row1Circle.bottom,
              text1ToRow2: b.row2Circle.top - b.text1.bottom,
              row2ToText2: b.text2.top - b.row2Circle.bottom,
              text2ToRow3: b.previewCircle.top - b.text2.bottom,
              previewCardToApprovalCard:
                b.approvalCard.top - b.previewCard.bottom,
              approvalCardToText3: b.text3.top - b.approvalCard.bottom,
              text3ToRow4: b.authCircle.top - b.text3.bottom,
              authCardToText4: b.text4.top - b.authCard.bottom,
            },
          };
        },
        {
          row1Circle: await row1Circle.elementHandle(),
          text1Bubble: await text1Bubble.elementHandle(),
          row2Circle: await row2Circle.elementHandle(),
          text2Bubble: await text2Bubble.elementHandle(),
          previewCircle: await previewCircle.elementHandle(),
          previewCard: await previewCard.elementHandle(),
          approvalCard: await approvalCard.elementHandle(),
          text3Bubble: await text3Bubble.elementHandle(),
          authCircle: await authCircle.elementHandle(),
          authCard: await authCard.elementHandle(),
          text4Bubble: await text4Bubble.elementHandle(),
        },
      );

      // Strict chronological top-to-bottom order.
      expect(geometry.boxes.row1Circle.bottom).toBeLessThan(
        geometry.boxes.text1.top,
      );
      expect(geometry.boxes.text1.bottom).toBeLessThan(
        geometry.boxes.row2Circle.top,
      );
      expect(geometry.boxes.row2Circle.bottom).toBeLessThan(
        geometry.boxes.text2.top,
      );
      expect(geometry.boxes.text2.bottom).toBeLessThan(
        geometry.boxes.previewCircle.top,
      );
      expect(geometry.boxes.previewCircle.bottom).toBeLessThan(
        geometry.boxes.previewCard.top,
      );
      expect(geometry.boxes.previewCard.bottom).toBeLessThan(
        geometry.boxes.approvalCard.top,
      );
      expect(geometry.boxes.approvalCard.bottom).toBeLessThan(
        geometry.boxes.text3.top,
      );
      expect(geometry.boxes.text3.bottom).toBeLessThan(
        geometry.boxes.authCircle.top,
      );
      expect(geometry.boxes.authCircle.bottom).toBeLessThan(
        geometry.boxes.authCard.top,
      );
      expect(geometry.boxes.authCard.bottom).toBeLessThan(
        geometry.boxes.text4.top,
      );

      // Canonical 16px chat block rhythm between every consecutive block, and
      // 8px separation between stacked open cards inside the same circle row.
      expect(geometry.gaps).toEqual({
        row1ToText1: 16,
        text1ToRow2: 16,
        row2ToText2: 16,
        text2ToRow3: 16,
        previewCardToApprovalCard: 8,
        approvalCardToText3: 16,
        text3ToRow4: 16,
        authCardToText4: 16,
      });

      await page.locator("#message-a1").screenshot({
        path: testInfo.outputPath(`tool-call-circles-${colorScheme}.png`),
      });

      // Clicking the auth-error circle expands its raw details below the auth
      // card while keeping the Re-authenticate button visible.
      await authCircle.click();
      await expect(authCircle).toHaveAttribute("aria-expanded", "true");
      await expect(reauthButton).toBeVisible();
      await expect(
        page.getByText("id-jag_test__get_server_info"),
      ).toBeVisible();

      // Clicking the approval circle toggles its card without closing the preview.
      await approvalCircle.click();
      await expect(approvalCircle).toHaveAttribute("aria-expanded", "false");
      await expect(approveButton).toBeHidden();
      await expect(policyDiff).toBeVisible();
    });
  });
}
