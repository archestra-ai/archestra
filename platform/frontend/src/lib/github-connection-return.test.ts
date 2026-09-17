import { beforeEach, expect, it, vi } from "vitest";
import {
  consumeGitHubConnectionReturn,
  rememberGitHubConnectionReturn,
} from "./github-connection-return";

beforeEach(() => window.sessionStorage.clear());

it("matches return destinations to individual OAuth attempts and consumes them once", () => {
  rememberGitHubConnectionReturn("organization-flow", "/settings/credentials");
  rememberGitHubConnectionReturn("personal-flow", "/account/connections");
  expect(consumeGitHubConnectionReturn("unknown-flow")).toBe(
    "/account/connections",
  );
  expect(consumeGitHubConnectionReturn("personal-flow")).toBe(
    "/account/connections",
  );
  expect(consumeGitHubConnectionReturn("organization-flow")).toBe(
    "/settings/credentials",
  );
  expect(consumeGitHubConnectionReturn("organization-flow")).toBe(
    "/account/connections",
  );
});

it("rejects unsupported destinations, even when stored values are modified", () => {
  rememberGitHubConnectionReturn("flow", "/agents");
  expect(consumeGitHubConnectionReturn("flow")).toBe("/account/connections");
  window.sessionStorage.setItem(
    "github-connection-return:flow",
    "https://external.example",
  );
  expect(consumeGitHubConnectionReturn("flow")).toBe("/account/connections");
  expect(consumeGitHubConnectionReturn(null)).toBe("/account/connections");
});

it.each([
  "/agents/agent-1?section=advanced&setup=credentials#runtime-credentials",
  "/settings/credentials?search=GitHub",
  "/account/connections#github",
  "/chat/conversation-1?agent_id=agent-1",
])("preserves the originating page, query, and fragment: %s", (destination) => {
  rememberGitHubConnectionReturn("flow", destination);
  expect(consumeGitHubConnectionReturn("flow")).toBe(destination);
  expect(consumeGitHubConnectionReturn("flow")).toBe("/account/connections");
});

it.each([
  "https://external.example/agents/agent-1",
  "//external.example/agents/agent-1",
  "/\\external.example/agents/agent-1",
  "javascript:alert(1)",
  "/github/callback?code=old-code",
])("rejects unsafe or recursive return destinations: %s", (destination) => {
  rememberGitHubConnectionReturn("flow", destination);
  expect(consumeGitHubConnectionReturn("flow")).toBe("/account/connections");
  window.sessionStorage.setItem("github-connection-return:flow", destination);
  expect(consumeGitHubConnectionReturn("flow")).toBe("/account/connections");
});

it("keeps sign-in usable when browser storage is unavailable", () => {
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Storage disabled");
  });
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage disabled");
  });
  try {
    expect(() =>
      rememberGitHubConnectionReturn("flow", "/settings/credentials"),
    ).not.toThrow();
    expect(consumeGitHubConnectionReturn("flow")).toBe("/account/connections");
  } finally {
    get.mockRestore();
    set.mockRestore();
  }
});
