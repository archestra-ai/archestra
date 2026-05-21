import { ChatErrorCode } from "@shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LimitExhaustedMessage } from "./limit-exhausted-message";

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppIconLogo: () => "/logo.png",
}));

vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>();
  return {
    ...actual,
    formatRelativeTimeFromNow: (date: string) => {
      const parsed = new Date(date);
      const now = Date.now();
      const diff = parsed.getTime() - now;
      if (diff < 0) return "1 second ago";
      return "in 2 hours";
    },
    formatLocalDateTime: (_date: string) => `May 22, 2026, 12:00 AM (UTC)`,
    cn: (...inputs: (string | undefined | null | false)[]) =>
      inputs.filter(Boolean).join(" "),
  };
});

describe("LimitExhaustedMessage", () => {
  it("renders limit details correctly", () => {
    const chatError = {
      code: ChatErrorCode.RateLimit,
      message: "The team usage limit of $25.00 has been reached.",
      isRetryable: true,
      limitInfo: {
        limitValue: 25,
        resetsAt: "2026-05-22T00:00:00.000Z",
        scope: "team",
      },
    };

    render(<LimitExhaustedMessage chatError={chatError} />);

    expect(screen.getByText("Usage limit reached")).toBeInTheDocument();
    expect(screen.getByText(/The team usage limit of/i)).toBeInTheDocument();
    expect(screen.getAllByText("$25.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Team").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("in 2 hours")).toBeInTheDocument();
    expect(
      screen.getByText(/Ask your administrator to increase this limit/i),
    ).toBeInTheDocument();
  });

  it("renders agent scope correctly", () => {
    const chatError = {
      code: ChatErrorCode.RateLimit,
      message: "The agent usage limit of $10.00 has been reached.",
      isRetryable: true,
      limitInfo: {
        limitValue: 10,
        resetsAt: "2026-05-22T00:00:00.000Z",
        scope: "agent",
      },
    };

    render(<LimitExhaustedMessage chatError={chatError} />);

    expect(screen.getAllByText("Agent").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("$10.00").length).toBeGreaterThanOrEqual(1);
  });

  it("renders organization scope correctly", () => {
    const chatError = {
      code: ChatErrorCode.RateLimit,
      message: "The organization usage limit of $100.00 has been reached.",
      isRetryable: true,
      limitInfo: {
        limitValue: 100,
        resetsAt: "2026-05-22T00:00:00.000Z",
        scope: "organization",
      },
    };

    render(<LimitExhaustedMessage chatError={chatError} />);

    expect(screen.getAllByText("Organization").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(screen.getAllByText("$100.00").length).toBeGreaterThanOrEqual(1);
  });

  it("renders virtual_key scope with fallback label", () => {
    const chatError = {
      code: ChatErrorCode.RateLimit,
      message: "The virtual_key usage limit of $5.00 has been reached.",
      isRetryable: true,
      limitInfo: {
        limitValue: 5,
        resetsAt: "2026-05-22T00:00:00.000Z",
        scope: "virtual_key",
      },
    };

    render(<LimitExhaustedMessage chatError={chatError} />);

    expect(screen.getByText("Virtual Key")).toBeInTheDocument();
  });

  it("shows reset state when reset time is in the past", () => {
    const chatError = {
      code: ChatErrorCode.RateLimit,
      message: "Limit reached.",
      isRetryable: true,
      limitInfo: {
        limitValue: 10,
        resetsAt: new Date(Date.now() - 1000).toISOString(),
        scope: "user",
      },
    };

    render(<LimitExhaustedMessage chatError={chatError} />);

    expect(screen.getByText("Limit has reset")).toBeInTheDocument();
    expect(screen.getByText("already reset")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The limit has reset. You can try sending your message again.",
      ),
    ).toBeInTheDocument();
  });

  it("shows 'All models' when models is not specified", () => {
    const chatError = {
      code: ChatErrorCode.RateLimit,
      message: "Limit reached.",
      isRetryable: true,
      limitInfo: {
        limitValue: 10,
        resetsAt: "2026-05-22T00:00:00.000Z",
        scope: "user",
      },
    };

    render(<LimitExhaustedMessage chatError={chatError} />);

    expect(screen.getByText("All models")).toBeInTheDocument();
  });

  it("shows specific models when models are provided", () => {
    const chatError = {
      code: ChatErrorCode.RateLimit,
      message: "Limit reached.",
      isRetryable: true,
      limitInfo: {
        limitValue: 10,
        resetsAt: "2026-05-22T00:00:00.000Z",
        scope: "agent",
        models: ["gpt-4o", "claude-3-5-sonnet"],
      },
    };

    render(<LimitExhaustedMessage chatError={chatError} />);

    expect(screen.getByText("gpt-4o, claude-3-5-sonnet")).toBeInTheDocument();
  });

  it("shows 'All models' when models is null", () => {
    const chatError = {
      code: ChatErrorCode.RateLimit,
      message: "Limit reached.",
      isRetryable: true,
      limitInfo: {
        limitValue: 10,
        resetsAt: "2026-05-22T00:00:00.000Z",
        scope: "team",
        models: null,
      },
    };

    render(<LimitExhaustedMessage chatError={chatError} />);

    expect(screen.getByText("All models")).toBeInTheDocument();
  });

  it("returns null when limitInfo is missing", () => {
    const chatError = {
      code: ChatErrorCode.RateLimit,
      message: "Rate limit exceeded.",
      isRetryable: true,
    };

    const { container } = render(
      <LimitExhaustedMessage chatError={chatError} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
