import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockOrganization: Record<string, unknown> | null = null;
const mockUpdateSecurityMutateAsync = vi.fn();

vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");

import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import {
  useOrganization,
  useUpdateSecuritySettings,
} from "@/lib/organization.query";
import { MediaInLogsSection } from "./media-in-logs-section";

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateSecurityMutateAsync.mockResolvedValue({});
  mockOrganization = { keepMediaInLogs: false };
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMissingPermissions).mockReturnValue(
    [] as unknown as ReturnType<typeof useMissingPermissions>,
  );
  vi.mocked(useOrganization).mockImplementation(
    () =>
      ({
        data: mockOrganization,
        isPending: false,
      }) as ReturnType<typeof useOrganization>,
  );
  vi.mocked(useUpdateSecuritySettings).mockReturnValue({
    mutateAsync: mockUpdateSecurityMutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateSecuritySettings>);
});

describe("MediaInLogsSection", () => {
  it("is off by default and saves it on", async () => {
    mockOrganization = {};
    render(<MediaInLogsSection />);
    const toggle = screen.getByRole("switch", { name: "Keep media in logs" });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    await userEvent.click(toggle);
    expect(toggle).toBeChecked();
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(mockUpdateSecurityMutateAsync).toHaveBeenCalledWith({
      keepMediaInLogs: true,
    });
  });

  it("shows the stored setting and discards an unsaved change", async () => {
    mockOrganization = { keepMediaInLogs: true };
    render(<MediaInLogsSection />);
    const toggle = screen.getByRole("switch", { name: "Keep media in logs" });
    expect(toggle).toBeChecked();

    await userEvent.click(toggle);
    await userEvent.click(
      await screen.findByRole("button", { name: "Cancel" }),
    );
    expect(toggle).toBeChecked();
    expect(mockUpdateSecurityMutateAsync).not.toHaveBeenCalled();
  });
});
