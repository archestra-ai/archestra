import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentNameCell } from "./agent-name-cell";

describe("AgentNameCell", () => {
  it("renders no visibility chip — visibility lives in the Accessible-to column", () => {
    render(<AgentNameCell name="My Agent" />);

    expect(screen.getByText("My Agent")).toBeInTheDocument();
    expect(screen.queryByText("Personal")).not.toBeInTheDocument();
    expect(screen.queryByText("Team")).not.toBeInTheDocument();
    expect(screen.queryByText("Organization")).not.toBeInTheDocument();
  });

  it("keeps the Built-in badge for built-in agents", () => {
    render(<AgentNameCell name="Built-in Agent" builtIn />);

    expect(screen.getByText("Built-in")).toBeInTheDocument();
  });
});
