import type { AgentTemplate } from "@shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentTemplateDetailsDialog } from "./agent-template-details-dialog";

const template: AgentTemplate = {
  id: "code-reviewer",
  name: "Code Reviewer",
  description: "Reviews repositories and issues.",
  type: "agent",
  categories: ["engineering", "collaboration"],
  systemPrompt: "Review code carefully.",
  llmModel: null,
  tools: ["github__search_repositories", "slack__send_message"],
  labels: [{ key: "template", value: "code-reviewer" }],
  icon: "🔎",
};

describe("AgentTemplateDetailsDialog", () => {
  it("renders the final plan details dialog content", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <AgentTemplateDetailsDialog
        open
        template={template}
        onOpenChange={onOpenChange}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: /Code Reviewer/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Reviews repositories and issues."),
    ).toBeInTheDocument();
    expect(screen.getByText("Review code carefully.")).toBeInTheDocument();
    expect(screen.getByText("engineering")).toBeInTheDocument();
    expect(screen.getByText("collaboration")).toBeInTheDocument();
    expect(screen.getByText("github__search_repositories")).toBeInTheDocument();
    expect(screen.getByText("slack__send_message")).toBeInTheDocument();
    expect(screen.getByText("template: code-reviewer")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
