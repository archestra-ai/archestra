import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UserMessageText } from "./user-message-text";

describe("UserMessageText", () => {
  it("renders markdown-looking pasted text as literal text", () => {
    const text =
      "TASK-1001 - Runbook wiki page write\nstatus: keep **Open**\nComment:\n\n_Deployitized_ html_page";

    const { container } = render(<UserMessageText text={text} />);

    expect(screen.getByText(/\*\*Open\*\*/)).toBeInTheDocument();
    expect(screen.getByText(/_Deployitized_/)).toBeInTheDocument();
    expect(container.querySelector("strong")).not.toBeInTheDocument();
    expect(container.querySelector("em")).not.toBeInTheDocument();
  });

  it("preserves user-entered line breaks with CSS instead of markdown hard breaks", () => {
    const { container } = render(<UserMessageText text={"first\nsecond"} />);

    expect(container.firstElementChild?.textContent).toBe("first\nsecond");
    expect(container.firstElementChild).toHaveClass("whitespace-pre-wrap");
  });
});
