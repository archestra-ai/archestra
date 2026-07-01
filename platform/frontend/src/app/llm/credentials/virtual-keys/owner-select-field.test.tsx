import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useMembersPaginated = vi.fn();

vi.mock("@/lib/auth/auth.query", () => {
  // Stable reference, like the real TanStack Query session, so the component's
  // accumulator effect doesn't re-run every render.
  const session = { data: { user: { id: "u-self" } } };
  return { useSession: () => session };
});

vi.mock("@/lib/member.query", () => ({
  useMembersPaginated: (...args: unknown[]) => useMembersPaginated(...args),
}));

vi.mock("@/lib/hooks/use-debounced-value", () => ({
  useDebouncedValue: (value: unknown) => value,
}));

import { OwnerSelectField, shouldShowOwnerField } from "./owner-select-field";

const MEMBERS = [
  { userId: "u-self", name: "Self Admin", email: "self@example.com" },
  { userId: "u-a", name: "Alice Anderson", email: "alice@example.com" },
  { userId: "u-b", name: "Bob Brown", email: "bob@example.com" },
];

describe("shouldShowOwnerField", () => {
  it("shows only for admins on personal scope", () => {
    expect(shouldShowOwnerField(true, "personal")).toBe(true);
    expect(shouldShowOwnerField(true, "team")).toBe(false);
    expect(shouldShowOwnerField(true, "org")).toBe(false);
    expect(shouldShowOwnerField(false, "personal")).toBe(false);
  });
});

describe("OwnerSelectField", () => {
  beforeEach(() => {
    useMembersPaginated.mockReset();
    useMembersPaginated.mockReturnValue({
      data: { data: MEMBERS },
      isFetching: false,
    });
  });

  it("excludes the signed-in user from the options", async () => {
    const user = userEvent.setup();
    render(<OwnerSelectField value="" onChange={vi.fn()} />);

    await user.click(screen.getByRole("combobox"));

    expect(
      screen.getByRole("button", { name: /Alice Anderson/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Bob Brown/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Self Admin/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("self@example.com")).not.toBeInTheDocument();
  });

  it("defaults to a 'Yourself' label when nothing is selected", () => {
    render(<OwnerSelectField value="" onChange={vi.fn()} />);
    expect(screen.getByRole("combobox")).toHaveTextContent("Yourself");
  });

  it("reports the picked user's id via onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OwnerSelectField value="" onChange={onChange} />);

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: /Bob Brown/i }));

    expect(onChange).toHaveBeenCalledWith("u-b");
  });

  it("drives a server-side member query as the user types", async () => {
    const user = userEvent.setup();
    render(<OwnerSelectField value="" onChange={vi.fn()} />);

    await user.click(screen.getByRole("combobox"));
    await user.type(
      screen.getByPlaceholderText("Search users by name or email"),
      "bob",
    );

    expect(useMembersPaginated).toHaveBeenCalledWith(
      expect.objectContaining({ name: "bob" }),
    );
  });
});
