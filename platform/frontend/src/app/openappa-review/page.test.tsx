import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { usePathname, useSearchParams } from "next/navigation";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  useOpenappaReview,
  useSubmitOpenappaReview,
} from "@/lib/openappa-review.query";
import OpenappaReviewPage from "./page";

vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/openappa-review.query");

const mutate = vi.fn();
beforeEach(() => {
  vi.mocked(usePathname).mockReturnValue("/openappa-review");
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams("task=task&approval=approval") as ReturnType<
      typeof useSearchParams
    >,
  );
  reviewState({
    isLoading: false,
    isError: false,
    data: {
      taskId: "task",
      approvalId: "approval",
      offerId: "offer",
      text: "Review this action",
    },
  });
  submitState({ isSuccess: false, isPending: false, mutate });
  mutate.mockClear();
});
afterEach(cleanup);

test("a recorded decision stays visible after the consumed review refetch returns unavailable", () => {
  reviewState({ isLoading: false, isError: true, data: undefined });
  submitState({
    isSuccess: true,
    variables: { taskId: "task", approvalId: "approval", ruling: "deny" },
    mutate,
  });
  render(<OpenappaReviewPage />);
  expect(screen.getByText("Decision recorded")).toBeInTheDocument();
  expect(screen.queryByText("Review unavailable")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Approve" }),
  ).not.toBeInTheDocument();
});

test("a previous review's success does not hide a newly opened review", () => {
  submitState({
    isSuccess: true,
    variables: {
      taskId: "other-task",
      approvalId: "other-approval",
      ruling: "approve",
    },
    mutate,
  });
  render(<OpenappaReviewPage />);
  expect(screen.getByText("Review this action")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  expect(screen.queryByText("Decision recorded")).not.toBeInTheDocument();
});

test("the browser submits an identity and decision, not edited tool arguments", () => {
  render(<OpenappaReviewPage />);
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(mutate).toHaveBeenCalledWith({
    taskId: "task",
    approvalId: "approval",
    ruling: "approve",
  });
});

function reviewState(value: Partial<ReturnType<typeof useOpenappaReview>>) {
  vi.mocked(useOpenappaReview).mockReturnValue(
    value as ReturnType<typeof useOpenappaReview>,
  );
}

function submitState(
  value: Partial<ReturnType<typeof useSubmitOpenappaReview>>,
) {
  vi.mocked(useSubmitOpenappaReview).mockReturnValue(
    value as ReturnType<typeof useSubmitOpenappaReview>,
  );
}
