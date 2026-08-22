import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFeature } from "@/lib/config/config.query";
import websocketService from "@/lib/websocket/websocket";
import SkillsLayout from "./layout";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/websocket/websocket", () => ({
  default: {
    connect: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

describe("SkillsLayout", () => {
  it("keeps MCP lifecycle synchronization active for every Skills route", () => {
    vi.mocked(useFeature).mockReturnValue(true);
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <SkillsLayout>
          <div>Skill route</div>
        </SkillsLayout>
      </QueryClientProvider>,
    );

    expect(websocketService.connect).toHaveBeenCalled();
    expect(websocketService.subscribe).toHaveBeenCalledWith(
      "mcp_servers_changed",
      expect.any(Function),
    );
    expect(websocketService.subscribe).toHaveBeenCalledWith(
      "websocket_ready",
      expect.any(Function),
    );
  });
});
