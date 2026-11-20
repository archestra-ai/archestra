import { archestraApiSdk } from "@archestra/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { authQueryKeys, useSession } from "@/lib/auth/auth.query";
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

test("a request refused as signed out has the session checked again at once, so an ended session is known without waiting for the next focus", async () => {
  serverAnswersPermissions(makeUserPermissions({ agent: ["read"] }));
  const listTools = vi.fn().mockResolvedValue(["tool"]);
  function Page() {
    const { data: session, isPending } = useSession();
    const tools = useQuery({ queryKey: ["tools"], queryFn: listTools });
    return (
      <>
        <span>
          {isPending ? "checking" : session?.user ? "signed in" : "signed out"}
        </span>
        <button type="button" onClick={() => tools.refetch()}>
          Load tools
        </button>
      </>
    );
  }
  render(
    <ArchestraQueryClientProvider>
      <Page />
    </ArchestraQueryClientProvider>,
  );
  expect(await screen.findByText("signed in")).toBeVisible();
  await waitFor(() => expect(listTools).toHaveBeenCalledTimes(1));
  const checks = vi.mocked(authClient.getSession).mock.calls.length;

  // The session ends on the server; the next request is refused.
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: null,
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
  listTools.mockRejectedValue(
    new Error("Sign in first", {
      cause: { error: { type: "api_authentication_error" } },
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Load tools" }));

  expect(await screen.findByText("signed out")).toBeVisible();
  expect(authClient.getSession).toHaveBeenCalledTimes(checks + 1);
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
