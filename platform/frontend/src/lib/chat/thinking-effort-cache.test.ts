import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  foldConfirmedThinkingEffort,
  readThinkingEffort,
  writePendingThinkingEffort,
} from "./thinking-effort-cache";

/**
 * A real QueryClient, not a stand-in: the bug this module exists to avoid was a
 * TanStack rule (an undefined value is treated as "no update"), which a Map
 * pretending to be a cache would happily let through.
 */
function seededClient(stored: "low" | "medium" | "high") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(["conversation", "c1"], {
    id: "c1",
    thinkingEffort: stored,
  });
  return queryClient;
}

describe("thinking effort cache", () => {
  it("reads the stored row when nothing is pending", () => {
    expect(readThinkingEffort(seededClient("low"), "c1")).toBe("low");
  });

  it("prefers a pick the server has not confirmed", () => {
    const queryClient = seededClient("low");
    writePendingThinkingEffort(queryClient, "c1", { effort: "high" });

    expect(readThinkingEffort(queryClient, "c1")).toBe("high");
  });

  it("survives the conversation being refetched mid-flight", () => {
    // Finishing a message invalidates the conversation query, and the refetch
    // returns the row the persist request has not reached yet.
    const queryClient = seededClient("low");
    writePendingThinkingEffort(queryClient, "c1", { effort: "high" });

    queryClient.setQueryData(["conversation", "c1"], {
      id: "c1",
      thinkingEffort: "low",
    });

    expect(readThinkingEffort(queryClient, "c1")).toBe("high");
  });

  it("really clears the pick rather than silently keeping it", () => {
    // Clearing with `undefined` is a no-op in TanStack, which left every later
    // turn reading a depth the composer had already abandoned.
    const queryClient = seededClient("low");
    writePendingThinkingEffort(queryClient, "c1", { effort: "high" });

    writePendingThinkingEffort(queryClient, "c1", null);

    expect(readThinkingEffort(queryClient, "c1")).toBe("low");
  });

  it("reports a confirmed write as the conversation's own value", () => {
    const queryClient = seededClient("low");
    writePendingThinkingEffort(queryClient, "c1", { effort: "high" });

    foldConfirmedThinkingEffort(queryClient, "c1", "high");
    writePendingThinkingEffort(queryClient, "c1", null);

    expect(readThinkingEffort(queryClient, "c1")).toBe("high");
  });

  it("leaves the row alone for a conversation it has not cached", () => {
    const queryClient = new QueryClient();
    foldConfirmedThinkingEffort(queryClient, "unknown", "high");

    expect(readThinkingEffort(queryClient, "unknown")).toBeUndefined();
  });
});
