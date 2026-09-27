import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useSearchParams } from "next/navigation";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { OpenAppaPageLayout } from "./openappa-page-layout";

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

  expect(screen.getAllByRole("link", { name: tabName })[0]).toHaveAttribute(
    "aria-current",
    "page",
  );
  const configureLink = screen.queryByRole("link", {
    name: "Configure with chat",
  });
  if (pathname === "/openappa/policy") {
    expect(
      await screen.findByRole("link", { name: "Configure with chat" }),
    ).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/chat\?agentId=appa-agent&user_prompt=Walk/),
    );
  } else {
    expect(configureLink).not.toBeInTheDocument();
  }
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
});
