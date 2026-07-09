import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useMembersPaginated = vi.fn();

// Stable reference, like the real TanStack Query session, so the component's
// accumulator effect doesn't re-run every render.
const mockSession = {
  data: { user: { id: "u-self", email: "self@example.com" } },
};

vi.mock("@/lib/auth/auth.query");

import { useSession } from "@/lib/auth/auth.query";

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
    vi.mocked(useSession).mockReturnValue(
      mockSession as unknown as ReturnType<typeof useSession>,
    );
    useMembersPaginated.mockReset();
    useMembersPaginated.mockReturnValue({
      data: { data: MEMBERS },
      isFetching: false,
    });
  });

  it("lists the signed-in user as 'Yourself' instead of their member entry", async () => {
    const user = userEvent.setup();
    render(<OwnerSelectField value="" onChange={vi.fn()} />);

    await user.click(screen.getByRole("combobox"));

    expect(
      screen.getByRole("button", { name: /Yourself/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Alice Anderson/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Bob Brown/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Self Admin/i }),
    ).not.toBeInTheDocument();
  });

  it("shows 'Yourself' as the selected owner when nothing is picked", () => {
    render(<OwnerSelectField value="" onChange={vi.fn()} />);
    expect(screen.getByRole("combobox")).toHaveTextContent("Yourself");
  });

  it("explains what the field is for", () => {
    render(<OwnerSelectField value="" onChange={vi.fn()} />);
    expect(screen.getByText("Key owner")).toBeInTheDocument();
    expect(
      screen.getByText(/on behalf of another member/i),
    ).toBeInTheDocument();
  });

  it("reports the picked user's id via onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OwnerSelectField value="" onChange={onChange} />);

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: /Bob Brown/i }));

    expect(onChange).toHaveBeenCalledWith("u-b");
  });

  it("resets to an empty owner when 'Yourself' is re-picked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OwnerSelectField value="u-b" onChange={onChange} />);

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("button", { name: /Yourself/i }));

    expect(onChange).toHaveBeenCalledWith("");
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
