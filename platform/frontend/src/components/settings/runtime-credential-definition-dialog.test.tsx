import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { RuntimeCredentialDefinitionDialog } from "./runtime-credential-definition-dialog";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

it.each([
  { name: "no App", apps: [] },
  {
    name: "an App without OAuth",
    apps: [
      {
        kind: "github_app",
        allowOrganization: true,
        githubUrl: "https://api.github.com",
        organizationConfigured: true,
        githubClientId: null,
      },
    ],
  },
  {
    name: "an App without connected credentials",
    apps: [
      {
        kind: "github_app",
        allowOrganization: true,
        githubUrl: "https://api.github.com",
        organizationConfigured: false,
        githubClientId: "example-client",
      },
    ],
  },
])("explains why GitHub user connections are unavailable with $name", async ({
  apps,
}) => {
  server.use(
    http.get("http://localhost:9000/api/credentials", () =>
      HttpResponse.json(apps),
    ),
  );
  const user = userEvent.setup();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RuntimeCredentialDefinitionDialog definition={null} onClose={() => {}} />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText(
      /GitHub user connections need an organization GitHub App first/,
    ),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: "Credential type" }));
  expect(
    screen.getByRole("option", { name: "GitHub user connection" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(
    screen.getByRole("option", { name: "GitHub App" }),
  ).not.toHaveAttribute("aria-disabled", "true");
});

it("enables a personal connection after an organization OAuth App is connected", async () => {
  server.use(
    http.get("http://localhost:9000/api/credentials", () =>
      HttpResponse.json([
        {
          key: "example-app",
          name: "Example App",
          kind: "github_app",
          allowOrganization: true,
          githubUrl: "https://api.github.com",
          organizationConfigured: true,
          githubClientId: "example-client",
        },
      ]),
    ),
  );
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RuntimeCredentialDefinitionDialog definition={null} onClose={() => {}} />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      screen.queryByText("Checking available GitHub Apps…"),
    ).not.toBeInTheDocument(),
  );
  await user.click(screen.getByRole("combobox", { name: "Credential type" }));
  await user.click(
    screen.getByRole("option", { name: "GitHub user connection" }),
  );
  expect(
    screen.getByRole("combobox", { name: "Organization GitHub App" }),
  ).toBeInTheDocument();
});
