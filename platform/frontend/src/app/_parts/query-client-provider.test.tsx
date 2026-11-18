import { archestraApiSdk } from "@archestra/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { makeSession, makeUserPermissions } from "@/mocks/data/auth";
import { ArchestraQueryClientProvider } from "./query-client-provider";

vi.mock("@/lib/clients/auth/auth-client");
vi.mock("@archestra/shared/api-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@archestra/shared/api-sdk")>()),
  getUserPermissions: vi.fn(),
  getScopedCapabilities: vi.fn(),
  getBootstrap: vi.fn(),
}));

type PermissionMap = ReturnType<typeof makeUserPermissions>;

const listAgents = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  listAgents.mockResolvedValue(["agent"]);
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: makeSession(),
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
  vi.mocked(archestraApiSdk.getBootstrap).mockResolvedValue({
    data: undefined,
  } as Awaited<ReturnType<typeof archestraApiSdk.getBootstrap>>);
  vi.mocked(archestraApiSdk.getScopedCapabilities).mockResolvedValue({
    data: [],
  } as unknown as Awaited<
    ReturnType<typeof archestraApiSdk.getScopedCapabilities>
  >);
});

test("refetches what the cache holds once the viewer's permissions change", async () => {
  serverAnswersPermissions(makeUserPermissions({ agent: ["read"] }));
  render(
    <ArchestraQueryClientProvider>
      <OpenPage />
    </ArchestraQueryClientProvider>,
  );
  await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(archestraApiSdk.getUserPermissions).toHaveBeenCalledTimes(1),
  );

  // An administrator changes the viewer's role; the tab asks again.
  serverAnswersPermissions(
    makeUserPermissions({ agent: ["read", "create", "delete"] }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Ask again" }));

  await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(2));
});

test("keeps what the cache holds when the permissions come back unchanged", async () => {
  serverAnswersPermissions(makeUserPermissions({ agent: ["read"] }));
  render(
    <ArchestraQueryClientProvider>
      <OpenPage />
    </ArchestraQueryClientProvider>,
  );
  await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(archestraApiSdk.getUserPermissions).toHaveBeenCalledTimes(1),
  );

  serverAnswersPermissions(makeUserPermissions({ agent: ["read"] }));
  await userEvent.click(screen.getByRole("button", { name: "Ask again" }));

  await waitFor(() =>
    expect(archestraApiSdk.getUserPermissions).toHaveBeenCalledTimes(2),
  );
  expect(listAgents).toHaveBeenCalledTimes(1);
});

function serverAnswersPermissions(permissions: PermissionMap) {
  vi.mocked(archestraApiSdk.getUserPermissions).mockResolvedValue({
    data: permissions,
  } as Awaited<ReturnType<typeof archestraApiSdk.getUserPermissions>>);
}

/** A page with a list on screen and a way to re-ask for the permission map. */
function OpenPage() {
  const client = useQueryClient();
  useQuery({ queryKey: ["agents"], queryFn: listAgents });
  return (
    <button
      type="button"
      onClick={() =>
        client.invalidateQueries({ queryKey: authQueryKeys.userPermissions() })
      }
    >
      Ask again
    </button>
  );
}
