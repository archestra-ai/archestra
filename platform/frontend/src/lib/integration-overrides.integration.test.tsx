import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth.query");
vi.mock("@archestra/shared", async () => {
  const actual =
    await vi.importActual<typeof import("@archestra/shared")>(
      "@archestra/shared",
    );
  return {
    ...actual,
    archestraApiSdk: { ...actual.archestraApiSdk, getOrganization: vi.fn() },
  };
});

import { useSession } from "@/lib/auth/auth.query";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { organizationKeys } from "@/lib/organization.query";

function XaiAvailability() {
  const catalog = useModelProviderCatalog();
  return <span>{catalog.isHidden("xai") ? "xai hidden" : "xai available"}</span>;
}

/**
 * The catalog decides what every picker may offer, so it has to reflect what
 * the server holds now — not what this browser cached before an admin changed
 * it. The cache is seeded the way a refresh does it (the organization query is
 * snapshotted and restored), which used to count as fresh for five minutes and
 * left turned-off providers on offer until the entry aged out.
 */
describe("useModelProviderCatalog freshness", () => {
  beforeEach(() => {
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
      isPending: false,
    } as unknown as ReturnType<typeof useSession>);
  });

  it("re-reads the organization on mount instead of trusting a restored cache", async () => {
    vi.mocked(archestraApiSdk.getOrganization).mockResolvedValue({
      data: { modelProviderOverrides: { xai: { hidden: true } } },
      error: undefined,
    } as unknown as Awaited<
      ReturnType<typeof archestraApiSdk.getOrganization>
    >);

    // The app's own default stale time, so this exercises the query's options
    // rather than a client configured to refetch everything.
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 60 * 1_000, retry: false } },
    });
    // Restored refresh snapshot: xAI was still available when it was written.
    client.setQueryData(organizationKeys.details(), {
      modelProviderOverrides: null,
    });

    render(
      <QueryClientProvider client={client}>
        <XaiAvailability />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText("xai hidden")).toBeInTheDocument(),
    );
    expect(archestraApiSdk.getOrganization).toHaveBeenCalled();
  });
});
