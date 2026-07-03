import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix dialog needs these in jsdom
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");

const submitMutate = vi.fn();
const mockState: {
  eligibility: { eligible: boolean } | undefined;
  isPending: boolean;
} = { eligibility: { eligible: true }, isPending: false };

vi.mock("@/lib/onboarding/onboarding.query", () => ({
  useOnboardingSurveyEligibility: ({ enabled }: { enabled: boolean }) => ({
    data: enabled ? mockState.eligibility : undefined,
  }),
  useSubmitOnboardingSurvey: () => ({
    mutate: submitMutate,
    isPending: mockState.isPending,
  }),
}));

vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
}));

import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { OnboardingSurveyDialog } from "./onboarding-survey-dialog";

beforeEach(() => {
  vi.clearAllMocks();
  mockState.eligibility = { eligible: true };
  mockState.isPending = false;
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
});

describe("OnboardingSurveyDialog", () => {
  it("does not render for non-admins", () => {
    vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
      typeof useHasPermissions
    >);
    render(<OnboardingSurveyDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not render when the org is not eligible", () => {
    mockState.eligibility = { eligible: false };
    render(<OnboardingSurveyDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders for an eligible admin, without a close button", () => {
    render(<OnboardingSurveyDialog />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /close/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps submit disabled until all three questions are answered", async () => {
    const user = userEvent.setup();
    render(<OnboardingSurveyDialog />);

    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Software engineer" }));
    await user.click(
      screen.getByRole("button", { name: "Startup (<50 people)" }),
    );
    expect(send).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "GitHub" }));
    expect(send).toBeEnabled();
  });

  it("submits the chosen labels and the optional email, closing on success", async () => {
    submitMutate.mockImplementation((_body, { onSuccess }) => onSuccess());
    const user = userEvent.setup();
    render(<OnboardingSurveyDialog />);

    await user.click(screen.getByRole("button", { name: "AI or ML team" }));
    await user.click(screen.getByRole("button", { name: "Large enterprise" }));
    await user.click(screen.getByRole("button", { name: "Conference" }));
    await user.type(
      screen.getByLabelText(/email for very concise/i),
      "jane@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(submitMutate).toHaveBeenCalledWith(
      {
        role: "AI or ML team",
        workEnvironment: "Large enterprise",
        referralSource: "Conference",
        workEmail: "jane@example.com",
      },
      expect.anything(),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays open when the submit does not succeed", async () => {
    submitMutate.mockImplementation(() => {});
    const user = userEvent.setup();
    render(<OnboardingSurveyDialog />);

    await user.click(screen.getByRole("button", { name: "Security engineer" }));
    await user.click(screen.getByRole("button", { name: "Mid-size company" }));
    await user.click(screen.getByRole("button", { name: "Reddit" }));
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("blocks submit on a malformed email", async () => {
    const user = userEvent.setup();
    render(<OnboardingSurveyDialog />);

    await user.click(screen.getByRole("button", { name: "Software engineer" }));
    await user.click(
      screen.getByRole("button", { name: "Startup (<50 people)" }),
    );
    await user.click(screen.getByRole("button", { name: "GitHub" }));
    await user.type(screen.getByLabelText(/email for very concise/i), "nope");

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});
