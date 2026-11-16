import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SectionNav } from "./section-nav";

vi.mock("next/navigation");
const push = vi.fn();

const items = [
  { href: "/settings/agents", label: "Agents" },
  {
    href: "/settings/messaging-channels",
    label: "Messaging Channels",
    subnav: <a href="/settings/messaging-channels/slack">Slack</a>,
  },
];

describe("SectionNav", () => {
  beforeEach(() => {
    push.mockClear();
    vi.mocked(usePathname).mockReturnValue("/settings/agents");
    vi.mocked(useRouter).mockReturnValue({
      push,
    } as unknown as ReturnType<typeof useRouter>);
    Element.prototype.scrollIntoView = vi.fn();
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
  });

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

  describe("the picker shown on phones", () => {
    it("names the section and the page inside it the reader is on", () => {
      vi.mocked(usePathname).mockReturnValue(
        "/settings/messaging-channels/ms-teams",
      );
      render(
        <SectionNav
          label="Settings sections"
          items={items}
          activeHref="/settings/messaging-channels"
        />,
      );

      const picker = screen.getByRole("button", { name: /Current section/ });
      expect(picker).toHaveTextContent("Messaging Channels");
      expect(picker).toHaveTextContent("Ms Teams");
    });

    it("finds a section by typing and opens it", async () => {
      const user = userEvent.setup();
      render(
        <SectionNav
          label="Settings sections"
          items={items}
          activeHref="/settings/agents"
        />,
      );

      await user.click(screen.getByRole("button", { name: /Current section/ }));
      const list = within(screen.getByRole("dialog"));
      await user.type(list.getByPlaceholderText("Search settings..."), "mess");
      expect(list.queryByRole("option", { name: "Agents" })).toBeNull();
      await user.click(
        list.getByRole("option", { name: "Messaging Channels" }),
      );

      expect(push).toHaveBeenCalledWith("/settings/messaging-channels");
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("lists the open section's pages, and closes once one is followed", async () => {
      const user = userEvent.setup();
      render(
        <SectionNav
          label="Settings sections"
          items={items}
          activeHref="/settings/messaging-channels"
        />,
      );

      await user.click(screen.getByRole("button", { name: /Current section/ }));
      const page = within(screen.getByRole("dialog")).getByRole("link", {
        name: "Slack",
      });
      page.addEventListener("click", (event) => event.preventDefault());
      await user.click(page);

      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});
