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

it("only permits the settings destinations, even when stored values are modified", () => {
  rememberGitHubConnectionReturn("flow", "/agents");
  expect(consumeGitHubConnectionReturn("flow")).toBe("/account/connections");
  window.sessionStorage.setItem(
    "github-connection-return:flow",
    "https://external.example",
  );
  expect(consumeGitHubConnectionReturn("flow")).toBe("/account/connections");
  expect(consumeGitHubConnectionReturn(null)).toBe("/account/connections");
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
