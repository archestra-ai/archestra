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
    name: "View usage for document-tools",
  });
  expect(summary).toHaveClass("py-1");
  expect(summary).toHaveTextContent("12·3 users·Never used");

  await userEvent.click(summary);
  expect(onClick).toHaveBeenCalledOnce();
});
