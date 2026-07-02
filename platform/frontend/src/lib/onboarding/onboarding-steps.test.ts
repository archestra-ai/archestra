import { describe, expect, it } from "vitest";
import {
  hasPendingOnboarding,
  isMenuStepDone,
  isSidebarTabDone,
  type MenuStep,
  menuStepForUrl,
  menuStepsForPath,
} from "./onboarding-steps";

const projects: MenuStep = { key: "projects", url: "/projects", tab: "chats" };
const connect: MenuStep = {
  key: "connect",
  url: "/connection",
  tab: "chats",
  altUrls: ["/connection_beta"],
};
const mcpRegistry: MenuStep = {
  key: "mcp-registry",
  url: "/mcp/registry",
  tab: "studio",
};
const modelProviders: MenuStep = {
  key: "model-providers",
  url: "/llm/model-providers",
  tab: "studio",
};
const steps = [projects, connect, mcpRegistry, modelProviders];

describe("isMenuStepDone", () => {
  it("is done once its key was hit", () => {
    expect(isMenuStepDone(projects, new Set())).toBe(false);
    expect(isMenuStepDone(projects, new Set(["projects"]))).toBe(true);
  });
});

describe("menuStepForUrl", () => {
  it("matches by primary url and by alternate (beta) url", () => {
    expect(menuStepForUrl("/projects", steps)).toBe(projects);
    expect(menuStepForUrl("/connection", steps)).toBe(connect);
    expect(menuStepForUrl("/connection_beta", steps)).toBe(connect);
    expect(menuStepForUrl("/nope", steps)).toBeUndefined();
  });
});

describe("menuStepsForPath", () => {
  it("matches exact url and deep-link prefix, incl. beta alternate", () => {
    expect(menuStepsForPath("/mcp/registry", steps)).toEqual([mcpRegistry]);
    expect(menuStepsForPath("/mcp/registry/foo", steps)).toEqual([mcpRegistry]);
    expect(menuStepsForPath("/connection_beta", steps)).toEqual([connect]);
  });

  it("does not match unrelated paths", () => {
    expect(menuStepsForPath("/projectsfoo", steps)).toEqual([]);
  });
});

describe("isSidebarTabDone", () => {
  it("a tab is done only once ALL its items are done", () => {
    expect(isSidebarTabDone("studio", new Set(), steps)).toBe(false);
    // one studio item done, the other still pending
    expect(isSidebarTabDone("studio", new Set(["mcp-registry"]), steps)).toBe(
      false,
    );
    expect(
      isSidebarTabDone(
        "studio",
        new Set(["mcp-registry", "model-providers"]),
        steps,
      ),
    ).toBe(true);
  });

  it("ignores steps the user can't see (visibleKeys)", () => {
    // model-providers is hidden by RBAC; mcp-registry is visited → tab is done.
    const visible = new Set(["mcp-registry"]);
    expect(
      isSidebarTabDone("studio", new Set(["mcp-registry"]), steps, visible),
    ).toBe(true);
  });
});

describe("hasPendingOnboarding", () => {
  it("is true while any item is incomplete, false once all are done", () => {
    expect(hasPendingOnboarding(new Set(), steps)).toBe(true);
    const allDone = new Set([
      "projects",
      "connect",
      "mcp-registry",
      "model-providers",
    ]);
    expect(hasPendingOnboarding(allDone, steps)).toBe(false);
  });

  it("only counts visible steps when visibleKeys is given", () => {
    // Only mcp-registry is visible and it's done → nothing pending, even though
    // other steps are unvisited (they're hidden from this user).
    const visible = new Set(["mcp-registry"]);
    expect(
      hasPendingOnboarding(new Set(["mcp-registry"]), steps, visible),
    ).toBe(false);
    expect(hasPendingOnboarding(new Set(), steps, visible)).toBe(true);
  });
});
