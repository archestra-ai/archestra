import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useSearchParams } from "next/navigation";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { OpenAppaPageLayout } from "./openappa-page-layout";

vi.mock("@/lib/auth/auth.query");
beforeEach(() => {
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
});
const server = setupServer(
  http.get("http://localhost:9000/api/agents/all", () =>
    HttpResponse.json([
      {
        id: "appa-agent",
        name: "OpenAPPA Configuration Agent",
        scope: "org",
        builtIn: true,
        builtInAgentConfig: { name: "openappa-configuration-agent" },
        authorId: null,
        labels: [],
      },
    ]),
  ),
);
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function show(children: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>,
  );
}
vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));
vi.mock("./batteries-panel", () => ({
  BatteriesUploadAction: () => null,
}));
const setupState = vi.hoisted(() => ({
  isFresh: false as boolean | undefined,
}));
vi.mock("./use-openappa-setup-state", () => ({
  useOpenAppaSetupState: () => setupState,
}));

test.each([
  ["/openappa", "Overview"],
  ["/openappa/batteries", "Batteries"],
  ["/openappa/policy", "Policy"],
])("selects %s as the %s tab", async (pathname, tabName) => {
  setupState.isFresh = false;
  vi.mocked(usePathname).mockReturnValue(pathname);
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );

  show(
    <OpenAppaPageLayout>
      <div>Content</div>
    </OpenAppaPageLayout>,
  );

  expect(
    (await screen.findAllByRole("link", { name: tabName }))[0],
  ).toHaveAttribute("aria-current", "page");
  expect(
    screen.getByRole("heading", {
      level: 1,
      name: `${pathname === "/openappa" ? "Guardrails" : tabName} Alpha`,
    }),
  ).toBeVisible();
  expect(
    screen.queryByRole("link", { name: "Configure with chat" }),
  ).not.toBeInTheDocument();
});

test("a fresh Overview hides the tabs until a policy is saved", () => {
  setupState.isFresh = true;
  vi.mocked(usePathname).mockReturnValue("/openappa");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );

  show(
    <OpenAppaPageLayout>
      <div>Content</div>
    </OpenAppaPageLayout>,
  );

  expect(screen.getByText("Content")).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Policy" }),
  ).not.toBeInTheDocument();
  // The header keeps naming the page and what it is for, tabs or no tabs.
  expect(
    screen.getByRole("heading", { level: 1, name: "Guardrails Alpha" }),
  ).toBeInTheDocument();
});

test("the header labels the feature as Alpha on every tab", () => {
  setupState.isFresh = false;
  vi.mocked(usePathname).mockReturnValue("/openappa/policy");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as ReturnType<typeof useSearchParams>,
  );

  show(
    <OpenAppaPageLayout>
      <div>Content</div>
    </OpenAppaPageLayout>,
  );

  expect(screen.getByText("Alpha")).toBeInTheDocument();
  // The browser tab keeps the plain name; the badge is only for the page.
  expect(document.title).toBe("Policy - Archestra");
});
