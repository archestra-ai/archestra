import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useFetchTeamTokenValue } from "@/lib/teams/team-token.query";
import type { useFetchUserTokenValue } from "@/lib/user-token.query";
import { CurlExampleSection } from "./curl-example-section";

vi.mock("sonner");

vi.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code, children }: { code: string; children?: ReactNode }) => (
    <div>
      <pre>{code}</pre>
      {children}
    </div>
  ),
}));

const { fetchUserTokenValueMock, fetchTeamTokenValueMock } = vi.hoisted(() => ({
  fetchUserTokenValueMock: vi.fn(),
  fetchTeamTokenValueMock: vi.fn(),
}));

const MASKED = "archestra_abc***";
const CODE = `curl -H "Authorization: Bearer ${MASKED}" http://localhost:9000/a2a/agent-1`;

function renderSection(
  overrides: Partial<Parameters<typeof CurlExampleSection>[0]> = {},
) {
  return render(
    <CurlExampleSection
      code={CODE}
      tokenForDisplay={MASKED}
      isPersonalTokenSelected
      hasAdminPermission={false}
      selectedTeamToken={null}
      fetchUserTokenMutation={
        {
          mutateAsync: fetchUserTokenValueMock,
          isPending: false,
        } as unknown as ReturnType<typeof useFetchUserTokenValue>
      }
      fetchTeamTokenMutation={
        {
          mutateAsync: fetchTeamTokenValueMock,
          isPending: false,
        } as unknown as ReturnType<typeof useFetchTeamTokenValue>
      }
      {...overrides}
    />,
  );
}

async function openCopyMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Copy" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchUserTokenValueMock.mockResolvedValue({ value: "archestra_real" });
});

describe("secret-aware copy menu", () => {
  it("copies the code with the real token only via the explicit menu action", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderSection();

    await openCopyMenu(user);
    await user.click(
      screen.getByRole("menuitem", { name: "Copy with real token" }),
    );

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        CODE.replace(MASKED, "archestra_real"),
      ),
    );
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      "Copied with real token",
    );
  });

  it("copies the code with an obviously-fake placeholder via the placeholder action", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderSection();

    await openCopyMenu(user);
    await user.click(
      screen.getByRole("menuitem", { name: "Copy with placeholder" }),
    );

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        CODE.replace(MASKED, "archestra_TOKEN"),
      ),
    );
    expect(fetchUserTokenValueMock).not.toHaveBeenCalled();
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      "Copied with placeholder token",
    );
  });

  it("copies nothing when the real token cannot be resolved", async () => {
    fetchUserTokenValueMock.mockResolvedValue(null);
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderSection();

    await openCopyMenu(user);
    await user.click(
      screen.getByRole("menuitem", { name: "Copy with real token" }),
    );

    await waitFor(() => expect(fetchUserTokenValueMock).toHaveBeenCalled());
    expect(writeText).not.toHaveBeenCalled();
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("offers only a plain placeholder copy when no real token is selectable", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const placeholderCode = CODE.replace(MASKED, "ask-admin-for-access-token");
    renderSection({
      code: placeholderCode,
      tokenForDisplay: "ask-admin-for-access-token",
      isPersonalTokenSelected: false,
      hasAdminPermission: false,
      selectedTeamToken: null,
    });

    // No menu: the button copies the placeholder form directly.
    await user.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        placeholderCode.replace(
          "ask-admin-for-access-token",
          "archestra_TOKEN",
        ),
      ),
    );
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    expect(fetchUserTokenValueMock).not.toHaveBeenCalled();
    expect(fetchTeamTokenValueMock).not.toHaveBeenCalled();
  });
});
