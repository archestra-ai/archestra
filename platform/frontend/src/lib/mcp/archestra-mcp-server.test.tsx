import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseAppName = vi.fn();
const mockConfig = {
  enterpriseFeatures: {
    fullWhiteLabeling: false,
  },
};

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => mockUseAppName(),
}));

vi.mock("@/lib/config/config", () => ({
  default: new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop in mockConfig
          ? mockConfig[prop as keyof typeof mockConfig]
          : undefined,
    },
  ),
}));

import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";

describe("useArchestraMcpIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.enterpriseFeatures.fullWhiteLabeling = false;
  });

  it("returns default built-in MCP identity when full white-labeling is disabled", () => {
    mockUseAppName.mockReturnValue("Sparky");
    mockConfig.enterpriseFeatures.fullWhiteLabeling = false;

    const { result } = renderHook(() => useArchestraMcpIdentity());

    expect(result.current.appName).toBe("Sparky");
    expect(result.current.catalogName).toBe("Archestra");
    expect(result.current.serverName).toBe("archestra");
    expect(result.current.getToolName("create_agent")).toBe(
      "archestra__create_agent",
    );
    expect(result.current.getToolShortName("archestra__create_agent")).toBe(
      "create_agent",
    );
    expect(result.current.isToolName("archestra__create_agent")).toBe(true);
  });

  it("returns branded MCP identity when full white-labeling is enabled", () => {
    mockUseAppName.mockReturnValue("Sparky");
    mockConfig.enterpriseFeatures.fullWhiteLabeling = true;

    const { result } = renderHook(() => useArchestraMcpIdentity());

    expect(result.current.catalogName).toBe("Sparky");
    expect(result.current.serverName).toBe("sparky");
    expect(result.current.getToolName("create_agent")).toBe(
      "sparky__create_agent",
    );
    expect(result.current.getToolShortName("sparky__create_agent")).toBe(
      "create_agent",
    );
    expect(result.current.isToolName("sparky__create_agent")).toBe(true);
    expect(result.current.isToolName("archestra__create_agent")).toBe(true);
  });

  it("returns stable references across rerenders when branding inputs are unchanged", () => {
    mockUseAppName.mockReturnValue("Sparky");
    mockConfig.enterpriseFeatures.fullWhiteLabeling = true;

    const { result, rerender } = renderHook(() => useArchestraMcpIdentity());
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
    expect(result.current.getToolName).toBe(first.getToolName);
    expect(result.current.getToolShortName).toBe(first.getToolShortName);
    expect(result.current.isToolName).toBe(first.isToolName);
  });
});
