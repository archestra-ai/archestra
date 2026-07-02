"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix Dialog/RadioGroup rely on browser APIs jsdom lacks.
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();
Element.prototype.scrollIntoView = vi.fn();

const mutate = vi.fn();

vi.mock("@/lib/onboarding/onboarding-survey.query", () => ({
  useSubmitOnboardingSurvey: () => ({ mutate, isPending: false }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { email: "admin@acme.com" } } }),
}));

import { OnboardingSurveyDialog } from "./onboarding-survey-dialog";

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OnboardingSurveyDialog />
    </QueryClientProvider>,
  );
}

/** Open a question's dropdown (by its label) and pick an option. */
async function pick(
  user: ReturnType<typeof userEvent.setup>,
  question: string,
  option: string,
) {
  await user.click(screen.getByRole("combobox", { name: question }));
  await user.click(screen.getByRole("option", { name: option }));
}

describe("OnboardingSurveyDialog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("submits the chosen answers with the prefilled email", async () => {
    const user = userEvent.setup();
    renderDialog();

    const submitButton = screen.getByRole("button", { name: "Continue" });
    expect(submitButton).toBeDisabled();

    await pick(user, "What do you do?", "Software engineer");
    await pick(user, "Where do you spend your days?", "Startup");
    await pick(user, "How'd you find us?", "GitHub");

    expect(submitButton).toBeEnabled();
    await user.click(submitButton);

    expect(mutate).toHaveBeenCalledWith({
      role: "Software engineer",
      workEnvironment: "Startup",
      referralSource: "GitHub",
      workEmail: "admin@acme.com",
    });
  });

  it("uses the free-text value when 'Other' is chosen", async () => {
    const user = userEvent.setup();
    renderDialog();

    await pick(user, "What do you do?", "SRE");
    await pick(user, "Where do you spend your days?", "Enterprise");
    await pick(user, "How'd you find us?", "Other");
    await user.type(screen.getByPlaceholderText("Tell us more"), "A podcast");

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ referralSource: "A podcast" }),
    );
  });
});
