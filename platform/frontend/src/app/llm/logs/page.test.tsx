import { describe, expect, it, vi } from "vitest";
import LlmProxyLogsPageServer from "./page";

// The interactions prefetch used to serialize ~10 full LLM request/response
// bodies into the RSC payload that no client code read — enough to OOM the
// platform container on a busy instance (T-1015). This pins the server
// component to prefetching the agents list only.

const getAllAgents = vi.hoisted(() => vi.fn());
const getInteractions = vi.hoisted(() => vi.fn());
vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getAllAgents,
      getInteractions,
    },
  };
});

vi.mock("@/lib/utils/server", () => ({
  getServerApiHeaders: vi.fn(async () => ({})),
}));

vi.mock("./page.client", () => ({
  default: () => null,
}));

describe("LlmProxyLogsPageServer (T-1015)", () => {
  it("prefetches only the agents list — never the interactions list", async () => {
    getAllAgents.mockResolvedValue({ data: [] });
    getInteractions.mockResolvedValue({ data: { data: [] } });

    await LlmProxyLogsPageServer();

    expect(getAllAgents).toHaveBeenCalledTimes(1);
    expect(getInteractions).not.toHaveBeenCalled();
  });
});
