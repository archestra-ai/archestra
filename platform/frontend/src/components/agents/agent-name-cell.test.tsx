import { render, screen } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentNameCell } from "./agent-name-cell";

vi.mock("next/navigation");

beforeEach(() => {
  vi.mocked(useRouter).mockReturnValue({
    prefetch: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
});

describe("AgentNameCell", () => {
  it("renders no visibility chip — visibility lives in the Accessible-to column", () => {
    render(<AgentNameCell name="My Agent" />);

    expect(screen.getByText("My Agent")).toBeInTheDocument();
    expect(screen.queryByText("Personal")).not.toBeInTheDocument();
    expect(screen.queryByText("Team")).not.toBeInTheDocument();
    expect(screen.queryByText("Organization")).not.toBeInTheDocument();
  });

  it("preserves the full name so truncation follows available space", () => {
    render(
      <AgentNameCell
        name="Engineering investigation assistant"
        href="/agents/preview"
      />,
    );
    expect(
      screen.getByRole("link", { name: "Engineering investigation assistant" }),
    ).toBeInTheDocument();
  });

  it("keeps the Built-in badge for built-in agents", () => {
    render(<AgentNameCell name="Built-in Agent" builtIn />);

    expect(screen.getByText("Built-in")).toBeInTheDocument();
  });

  it("renders a leading icon inline before the name when provided", () => {
    render(
      <AgentNameCell
        name="Iconic Agent"
        icon={<span data-testid="agent-icon" />}
      />,
    );

    expect(screen.getByTestId("agent-icon")).toBeInTheDocument();
    expect(screen.getByText("Iconic Agent")).toBeInTheDocument();
  });
});
