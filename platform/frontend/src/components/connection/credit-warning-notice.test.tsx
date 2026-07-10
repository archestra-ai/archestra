import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CreditWarningNotice } from "./credit-warning-notice";

describe("CreditWarningNotice", () => {
  it("renders nothing when there is no warning", () => {
    const { container } = render(<CreditWarningNotice warning={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the unified balance message naming the key whose balance is too low", () => {
    render(
      <CreditWarningNotice
        warning={{ kind: "insufficient_balance", keyName: "Prod Anthropic" }}
      />,
    );
    expect(screen.getByTestId("connection-credit-warning")).toBeInTheDocument();
    expect(
      screen.getByText(/remaining usage balance is too low/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Provider API key name: Prod Anthropic\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Please contact your administrator or try again later/i),
    ).toBeInTheDocument();
  });

  it("shows a retry-friendly message naming the key when it is unverified", () => {
    render(
      <CreditWarningNotice
        warning={{ kind: "unverified", keyName: "Prod Anthropic" }}
      />,
    );
    expect(screen.getByTestId("connection-credit-warning")).toBeInTheDocument();
    expect(screen.getByText(/couldn.t verify/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Provider API key name: Prod Anthropic\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/try again/i)).toBeInTheDocument();
  });
});
