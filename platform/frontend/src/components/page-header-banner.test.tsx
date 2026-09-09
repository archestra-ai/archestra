import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  PageHeaderBanner,
  PageHeaderBannerSlotContext,
} from "@/components/page-header-banner";

describe("PageHeaderBanner", () => {
  it("renders in place when there is no host content slot", () => {
    // The fallback the clone/create surfaces and the unit tests rely on: with
    // no PageLayout to pin into, the notice still shows where it stands.
    render(
      <PageHeaderBanner>
        <span>1 MCP server not in this environment</span>
      </PageHeaderBanner>,
    );

    expect(
      screen.getByText("1 MCP server not in this environment"),
    ).toBeInTheDocument();
  });

  it("portals its children into the content slot the layout provides", () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);

    render(
      <PageHeaderBannerSlotContext.Provider value={slot}>
        <PageHeaderBanner>
          <span>1 MCP server not in this environment</span>
        </PageHeaderBanner>
      </PageHeaderBannerSlotContext.Provider>,
    );

    // The notice lands in the content slot, not beside where it was declared.
    expect(slot).toHaveTextContent("1 MCP server not in this environment");

    slot.remove();
  });
});
