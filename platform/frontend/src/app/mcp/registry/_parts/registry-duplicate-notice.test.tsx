import { act, fireEvent, render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useInternalMcpCatalogMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: useInternalMcpCatalogMock,
}));

import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import { RegistryDuplicateNotice } from "./registry-duplicate-notice";

const ITEMS = [
  {
    id: "id-linear",
    name: "linear",
    serverType: "remote",
    serverUrl: "https://mcp.linear.app/mcp",
  },
];

function Harness({ values }: { values: Partial<McpCatalogFormValues> }) {
  const form = useForm<McpCatalogFormValues>({
    defaultValues: values as McpCatalogFormValues,
  });
  return <RegistryDuplicateNotice form={form} />;
}

describe("RegistryDuplicateNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useInternalMcpCatalogMock.mockReturnValue({ data: ITEMS });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("warns about a registry duplicate and links to the existing server's editor", () => {
    render(
      <Harness
        values={{ name: "", serverUrl: "https://mcp.linear.app/mcp" }}
      />,
    );
    // Detection is debounced — nothing before the debounce elapses.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      /is already in your registry \(same server URL\) — you may be recreating it/,
    );
    // The offer is the existing server's editor — never re-creating or
    // pre-filling from it.
    expect(
      screen.getByRole("link", { name: "Show existing server" }),
    ).toHaveAttribute("href", "/mcp/registry/id-linear/edit");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("stays silent without a match", () => {
    render(
      <Harness
        values={{ name: "brand-new", serverUrl: "https://other.example.com" }}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
