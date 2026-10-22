import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SectionNav } from "./section-nav";

const items = [
  { href: "/settings/agents", label: "Agents" },
  {
    href: "/settings/messaging-channels",
    label: "Messaging Channels",
    subnav: <a href="/settings/messaging-channels/slack">Slack</a>,
  },
];

describe("SectionNav", () => {
  it("lists a section's pages under it while it is open", () => {
    render(
      <SectionNav
        label="Settings sections"
        items={items}
        activeHref="/settings/messaging-channels"
      />,
    );

    expect(screen.getByRole("link", { name: "Slack" })).toBeInTheDocument();
    // The open page is marked in the subnav, not on the section itself.
    expect(
      screen.getByRole("link", { name: "Messaging Channels" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("hides a section's pages while another section is open", () => {
    render(
      <SectionNav
        label="Settings sections"
        items={items}
        activeHref="/settings/agents"
      />,
    );

    expect(screen.queryByRole("link", { name: "Slack" })).toBeNull();
    expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
