import type { archestraCatalogTypes } from "@archestra/shared";
import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { ServerDetails } from "./server-details";

it("keeps remote connection details and configuration available without a README or repository", () => {
  const server = {
    name: "example__remote-mcp",
    display_name: "Example server",
    description: "A remote server",
    author: { name: "Example publisher" },
    category: "Development",
    programming_language: null,
    github_info: null,
    readme: null,
    license: "MIT",
    server: {
      type: "remote",
      url: "https://example.com/mcp",
      docs_url: "https://example.com/connection",
    },
    user_config: {
      endpoint: {
        type: "string",
        title: "Endpoint",
        description: "The service endpoint",
        required: true,
        default: "https://example.com",
      },
    },
  } satisfies archestraCatalogTypes.ArchestraMcpServerManifest;

  render(<ServerDetails server={server} />);

  const setup = within(
    screen.getByRole("complementary", { name: "Server setup" }),
  );
  expect(setup.getByRole("link", { name: server.server.url })).toHaveAttribute(
    "href",
    server.server.url,
  );
  expect(
    setup.getByRole("link", { name: "Connection documentation" }),
  ).toHaveAttribute("href", server.server.docs_url);
  expect(setup.getByText("The service endpoint")).toBeInTheDocument();
  expect(setup.getByText("Required")).toBeInTheDocument();
  expect(setup.getByText("https://example.com")).toBeInTheDocument();
  expect(setup.getByText("MIT")).toBeInTheDocument();
  expect(setup.getByText("Example publisher")).toBeInTheDocument();
});
