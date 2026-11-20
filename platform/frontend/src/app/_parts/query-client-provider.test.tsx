import { archestraApiClient, archestraApiSdk } from "@archestra/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { authQueryKeys, useSession } from "@/lib/auth/auth.query";
import { signedOutRefusal } from "@/lib/auth/signed-out-refusal";
import { authClient } from "@/lib/clients/auth/auth-client";
import { makeSession, makeUserPermissions } from "@/mocks/data/auth";
import { ArchestraQueryClientProvider } from "./query-client-provider";

vi.mock("@/lib/clients/auth/auth-client");
vi.mock("@archestra/shared", async () => {
  const actual = await vi.importActual("@archestra/shared");
  return {
    ...actual,
    archestraApiSdk: {
      getUserPermissions: vi.fn(),
      getScopedCapabilities: vi.fn(),
      getBootstrap: vi.fn(),
    },
  };
});

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

/** A page that shows whether it believes it is signed in. */
function SessionPage({ onAct }: { onAct: () => void }) {
  const { data: session, isPending } = useSession();
  return (
    <>
      <span>
        {isPending ? "checking" : session?.user ? "signed in" : "signed out"}
      </span>
      <button type="button" onClick={onAct}>
        Act
      </button>
    </>
  );
}

function sessionEndsOnTheServer() {
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: null,
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
}

test("a request the server refuses as signed out has the session checked again at once, even when its caller turns the error into a value and never rejects", async () => {
  serverAnswersPermissions(makeUserPermissions({ agent: ["read"] }));
  const refused = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: { type: "api_authentication_error", message: "Sign in first" },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
  );
  archestraApiClient.setConfig({
    baseUrl: "http://localhost:9000",
    fetch: refused,
  });
  // Like the mutations that answer `false` for a failed request.
  const saved: boolean[] = [];
  const save = async () => {
    const { error } = await archestraApiClient.post({ url: "/api/anything" });
    saved.push(!error);
  };
  try {
    render(
      <ArchestraQueryClientProvider>
        <SessionPage onAct={() => void save()} />
      </ArchestraQueryClientProvider>,
    );
    expect(await screen.findByText("signed in")).toBeVisible();
    const checks = vi.mocked(authClient.getSession).mock.calls.length;

    sessionEndsOnTheServer();
    await userEvent.click(screen.getByRole("button", { name: "Act" }));

    expect(await screen.findByText("signed out")).toBeVisible();
    expect(saved).toEqual([false]);
    expect(authClient.getSession).toHaveBeenCalledTimes(checks + 1);
  } finally {
    archestraApiClient.setConfig({ baseUrl: "", fetch: undefined });
  }
});

test("a burst of refusals, such as the auth client's, shares one session check, and a page that is signed out already asks for none", async () => {
  serverAnswersPermissions(makeUserPermissions({ agent: ["read"] }));
  render(
    <ArchestraQueryClientProvider>
      <SessionPage
        onAct={() => {
          signedOutRefusal.report();
          signedOutRefusal.report();
          signedOutRefusal.report();
        }}
      />
    </ArchestraQueryClientProvider>,
  );
  expect(await screen.findByText("signed in")).toBeVisible();
  const checks = vi.mocked(authClient.getSession).mock.calls.length;

  sessionEndsOnTheServer();
  await userEvent.click(screen.getByRole("button", { name: "Act" }));
  expect(await screen.findByText("signed out")).toBeVisible();
  expect(authClient.getSession).toHaveBeenCalledTimes(checks + 1);

  // Signed out now: a later refusal, such as a wrong password, checks nothing.
  await userEvent.click(screen.getByRole("button", { name: "Act" }));
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
