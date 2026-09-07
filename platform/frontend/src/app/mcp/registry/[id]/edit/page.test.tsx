import { PLAYWRIGHT_MCP_CATALOG_ID } from "@archestra/shared";
import { redirect } from "next/navigation";
import { expect, it, vi } from "vitest";
import McpCatalogItemEditPageServer from "./page";

vi.mock("next/navigation");
vi.mock("./page.client", () => ({ McpCatalogItemEditPage: () => null }));

it("redirects direct Playwright edit visits to the managed server details", async () => {
  const redirected = new Error("redirected");
  vi.mocked(redirect).mockImplementationOnce(() => {
    throw redirected;
  });
  await expect(
    McpCatalogItemEditPageServer({
      params: Promise.resolve({ id: PLAYWRIGHT_MCP_CATALOG_ID }),
    }),
  ).rejects.toBe(redirected);
  expect(redirect).toHaveBeenCalledWith(
    `/mcp/registry/${PLAYWRIGHT_MCP_CATALOG_ID}`,
  );
});
