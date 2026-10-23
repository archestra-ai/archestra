import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import { makeAgent } from "../src/mocks/data/agents";
import { makeUserPermissions } from "../src/mocks/data/auth";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";

test("scrolls through bounded agent batches without pagination or losing the draft", async ({
  page,
  mswControl,
}) => {
  const key = makeLlmProviderApiKey({ bestModelId: "model-1" });
  const agents = Array.from({ length: 45 }, (_, index) =>
    makeAgent({
      id: `choice-${index}`,
      name: `Choice ${String(index).padStart(2, "0")}`,
      scope: "org",
      accessAllTools: true,
    }),
  );
  const batch = (offset: number) => ({
    data: agents.slice(offset, offset + 20),
    pagination: {
      limit: 20,
      hasNext: offset + 20 < agents.length,
      nextCursor: offset + 20 < agents.length ? String(offset + 20) : null,
    },
  });
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/user/permissions",
      body: makeUserPermissions({
        chat: ["read", "create", "update", "delete", "full-view"],
      }),
    },
    { method: "get", url: "/api/llm-provider-api-keys", body: [key] },
    { method: "get", url: "/api/llm-provider-api-keys/available", body: [key] },
    {
      method: "get",
      url: "/api/llm-models/available",
      body: [
        {
          dbId: "model-1",
          id: "test-model",
          displayName: "Test model",
          provider: "anthropic",
          isFree: false,
          isBest: true,
        },
      ],
    },
    {
      method: "get",
      url: "/api/members/default-model",
      body: { modelId: null, chatApiKeyId: null },
    },
    { method: "get", url: "/api/agents/chat-roster", body: [agents[0]] },
    { method: "get", url: `/api/agents/${agents[0].id}`, body: agents[0] },
    { method: "get", url: `/api/agents/${agents[44].id}`, body: agents[44] },
    { method: "get", url: "/api/agents/chat-roster/page", body: batch(0) },
    {
      method: "get",
      url: "/api/agents/chat-roster/page",
      query: { cursor: "20" },
      body: batch(20),
    },
    {
      method: "get",
      url: "/api/agents/chat-roster/page",
      query: { cursor: "40" },
      body: batch(40),
    },
  ]);
  const requests: URL[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/agents/chat-roster/page")
      requests.push(new URL(request.url()));
  });
  await page.goto("/chat");
  const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
  await textarea.fill("Keep this draft while browsing agents");
  const trigger = page.getByRole("combobox", {
    name: "Choice 00",
    exact: true,
  });
  await expect(trigger).toBeVisible();
  expect(requests).toHaveLength(0);
  await trigger.click();
  const list = page.getByRole("listbox", { name: "Agents" });
  await expect(list.getByRole("option")).toHaveCount(20);
  expect(requests).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: "Next", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Previous", exact: true }),
  ).toHaveCount(0);
  await list
    .getByRole("option", { name: /Choice 19/ })
    .scrollIntoViewIfNeeded();
  await expect(list.getByRole("option")).toHaveCount(40);
  expect(requests).toHaveLength(2);
  await list
    .getByRole("option", { name: /Choice 39/ })
    .scrollIntoViewIfNeeded();
  await expect(list.getByRole("option")).toHaveCount(45);
  expect(requests.map((url) => url.searchParams.get("cursor"))).toEqual([
    null,
    "20",
    "40",
  ]);
  expect(requests.every((url) => url.searchParams.get("limit") === "20")).toBe(
    true,
  );
  await list.getByRole("option", { name: /Choice 44/ }).click();
  await expect(
    page.getByRole("combobox", { name: "Choice 44", exact: true }),
  ).toBeVisible();
  await expect(textarea).toHaveValue("Keep this draft while browsing agents");
});
