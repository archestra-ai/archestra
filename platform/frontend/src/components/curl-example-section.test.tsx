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

beforeEach(() => {
  vi.clearAllMocks();
  fetchUserTokenValueMock.mockResolvedValue({ value: "archestra_real" });
});

describe("copy with exposed token", () => {
  it("copies the code with the real token in place of the mask", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderSection();

    await user.click(
      screen.getByRole("button", { name: "Copy with exposed token" }),
    );

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        CODE.replace(MASKED, "archestra_real"),
      ),
    );
  });

  it("copies nothing when the masked token cannot be resolved", async () => {
    fetchUserTokenValueMock.mockResolvedValue(null);
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderSection();

    await user.click(
      screen.getByRole("button", { name: "Copy with exposed token" }),
    );

    await waitFor(() => expect(fetchUserTokenValueMock).toHaveBeenCalled());
    expect(writeText).not.toHaveBeenCalled();
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("copies the placeholder code as-is when no real token is selectable", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const placeholderCode = CODE.replace(MASKED, "ask-admin-for-access-token");
    renderSection({
      code: placeholderCode,
      tokenForDisplay: "ask-admin-for-access-token",
      isPersonalTokenSelected: false,
      hasAdminPermission: true,
      selectedTeamToken: null,
    });

    await user.click(
      screen.getByRole("button", { name: "Copy with exposed token" }),
    );

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(placeholderCode),
    );
    expect(fetchUserTokenValueMock).not.toHaveBeenCalled();
    expect(fetchTeamTokenValueMock).not.toHaveBeenCalled();
  });
});
