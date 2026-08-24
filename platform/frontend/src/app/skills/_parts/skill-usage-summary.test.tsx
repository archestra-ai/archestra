import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { SkillUsageSummary } from "./skill-usage-summary";

it("presents skill usage as one compact, interactive summary", async () => {
  const onClick = vi.fn();
  render(
    <SkillUsageSummary
      usageCount={12}
      usageUserCount={3}
      lastUsedAt={null}
      label="View usage for document-tools"
      onClick={onClick}
    />,
  );

  const summary = screen.getByRole("button", {
    name: "View usage for document-tools: 12 uses, 3 users, Never used",
  });
  expect(summary).toHaveTextContent("12");
  expect(summary).not.toHaveTextContent("3 users");

  await userEvent.hover(summary);
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip).toHaveTextContent("12 uses");
  expect(tooltip).toHaveTextContent("3 users · Never used");

  await userEvent.click(summary);
  expect(onClick).toHaveBeenCalledOnce();
});
