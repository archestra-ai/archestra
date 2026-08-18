import { describe, expect, it, vi } from "vitest";
import LlmProxyLogsPageServer from "./page";

// This server component used to prefetch data that only bloated the RSC
// payload: first ~10 full LLM request/response bodies that no client code
// read — enough to OOM the platform container on a busy instance (T-1015) —
// and later the whole agent roster for a filter dropdown the client refetches
// anyway. It pins the server component to prefetching nothing at all.

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
  it("prefetches nothing server-side — no interactions, no agent roster", async () => {
    getAllAgents.mockResolvedValue({ data: [] });
    getInteractions.mockResolvedValue({ data: { data: [] } });

    LlmProxyLogsPageServer();

    expect(getAllAgents).not.toHaveBeenCalled();
    expect(getInteractions).not.toHaveBeenCalled();
  });
});
