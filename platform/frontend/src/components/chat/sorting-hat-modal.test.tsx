import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { getSortingHatSessionKey, SortingHatModal } from "./sorting-hat-modal";

describe("SortingHatModal", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("opens once for the first tool invocation in a session", async () => {
    render(
      <SortingHatModal
        conversationId="conversation-1"
        hasToolInvocation={true}
        monologue={["First line", "Second line"]}
      />,
    );

    expect(await screen.findByText("Sorting Hat")).toBeInTheDocument();
    expect(await screen.findByText("First line")).toBeInTheDocument();
    expect(await screen.findByText("Second line")).toBeInTheDocument();

    expect(
      window.sessionStorage.getItem(getSortingHatSessionKey("conversation-1")),
    ).toBe("shown");
  });

  it("does not reopen after the session key is set", async () => {
    window.sessionStorage.setItem(
      getSortingHatSessionKey("conversation-1"),
      "shown",
    );

    render(
      <SortingHatModal
        conversationId="conversation-1"
        hasToolInvocation={true}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Sorting Hat")).not.toBeInTheDocument();
    });
  });
});
