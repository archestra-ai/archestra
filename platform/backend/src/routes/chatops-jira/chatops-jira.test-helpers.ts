import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import ChatOpsConfigModel from "@/models/chatops-config";
import { afterEach, beforeEach } from "@/test";
import { useMswServer } from "@/test/msw";
import type { User } from "@/types";
import type { JiraBotConfig, JiraDbConfig } from "@/types/chatops-jira";
import { drainBackgroundWork } from "@/utils/background-work";
import jiraChatOpsRoutes from "./chatops-jira.routes";

export const JIRA_TEST_SITE = "https://example.atlassian.net";
export const JIRA_TEST_SECRET = "test-webhook-secret-at-least-sixteen";

export function useJiraRouteTest() {
  const ctx = {} as {
    app: FastifyInstanceWithZod;
    user: User;
    organizationId: string;
  };
  const server = useMswServer(
    http.get(`${JIRA_TEST_SITE}/rest/api/3/myself`, () =>
      HttpResponse.json({
        accountId: "jira-bot-account",
        displayName: "Issue helper",
        active: true,
        emailAddress: "bot@example.test",
      }),
    ),
  );
  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    ctx.organizationId = (await makeOrganization()).id;
    ctx.user = await makeAdmin();
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    vi.spyOn(chatOpsManager, "reloadJiraProviders").mockResolvedValue();
    ctx.app = createFastifyInstance();
    ctx.app.addHook("onRequest", async (request) => {
      Object.assign(request, {
        user: ctx.user,
        organizationId: ctx.organizationId,
      });
    });
    registerAuditLogHook(ctx.app);
    await ctx.app.register(jiraChatOpsRoutes);
  });
  afterEach(async () => {
    await drainBackgroundWork();
    await ctx.app?.close();
    vi.restoreAllMocks();
  });
  return { ctx, server };
}

export async function seedJiraConfig(
  organizationId: string,
  agentId?: string,
): Promise<JiraDbConfig> {
  const bot: JiraBotConfig = {
    id: randomUUID(),
    agentId: agentId ?? randomUUID(),
    accountId: "jira-bot-account",
    displayName: "Issue helper",
    email: "bot@example.test",
    apiToken: "test-only-bot-api-token",
    enabled: true,
  };
  const value: JiraDbConfig = {
    id: randomUUID(),
    organizationId,
    siteUrl: JIRA_TEST_SITE,
    enabled: true,
    ingressMode: "hmac",
    webhookSecret: JIRA_TEST_SECRET,
    bots: agentId ? [bot] : [],
  };
  await ChatOpsConfigModel.saveJiraConfig(value);
  return value;
}
