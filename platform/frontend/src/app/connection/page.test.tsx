import { act, fireEvent, render, screen } from "@testing-library/react";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDefaultMcpGateway } from "@/lib/agent.query";
import { useLlmProxy } from "@/lib/llm-proxy.query";
import { useOrganization } from "@/lib/organization.query";
import ConnectionPage from "./page";

const connectionFlowMock = vi.fn((_props: unknown) => (
  <div data-testid="connection-flow">
    <input aria-label="Selected gateway" defaultValue="Default gateway" />
  </div>
));
const refetchOrganizationMock = vi.fn();

vi.mock("next/navigation");
vi.mock("@/lib/agent.query");
vi.mock("@/lib/llm-proxy.query");
vi.mock("@/lib/organization.query");
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./connection-flow", () => ({
  ConnectionFlow: (props: unknown) => connectionFlowMock(props),
}));

describe("ConnectionPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("mode=manual") as ReturnType<typeof useSearchParams>,
    );
    refetchOrganizationMock.mockResolvedValue({});
    vi.mocked(useDefaultMcpGateway).mockReturnValue({
      data: undefined,
    } as ReturnType<typeof useDefaultMcpGateway>);
    vi.mocked(useLlmProxy).mockReturnValue({
      data: undefined,
    } as ReturnType<typeof useLlmProxy>);
  });

  it("shows only the prompt by default, without preparing a manual setup", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
      refetch: refetchOrganizationMock,
    } as unknown as ReturnType<typeof useOrganization>);
    render(<ConnectionPage />);
    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Other ways to connect" }),
    ).toHaveAttribute("href", "/connection?mode=manual");
    expect(connectionFlowMock).not.toHaveBeenCalled();
  });

  it.each([
    "clientId=claude-desktop",
    "connectRequest=request&clientId=codex",
  ])("opens setup directly for %s", (query) => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams(query) as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useOrganization).mockReturnValue({
      data: {},
      isFetchedAfterMount: true,
      isFetching: false,
      isError: false,
      refetch: refetchOrganizationMock,
    } as unknown as ReturnType<typeof useOrganization>);
    render(<ConnectionPage />);
    expect(screen.queryByRole("button", { name: "Copy prompt" })).toBeNull();
    expect(connectionFlowMock).toHaveBeenCalled();
  });

  it("fails closed while a persisted enabled value is being revalidated", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: {
        connectionSkillsEnabled: true,
        connectionLlmProxyEnabled: true,
        connectionPluginsEnabled: true,
      },
      isFetchedAfterMount: false,
      isFetching: true,
      isError: false,
      refetch: refetchOrganizationMock,
    } as unknown as ReturnType<typeof useOrganization>);

    render(<ConnectionPage />);

    expect(useOrganization).toHaveBeenCalledWith(true, { fresh: true });
    expect(useLlmProxy).toHaveBeenCalledWith({ enabled: false });
    expect(connectionFlowMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("status", { name: "Checking connection settings" }),
    ).toBeInTheDocument();
  });

  it("hides setup actions during revalidation without dropping selections or enabled inputs", () => {
    const query = {
      data: {
        connectionSkillsEnabled: true,
        connectionLlmProxyEnabled: true,
        connectionPluginsEnabled: true,
      },
      isFetchedAfterMount: true,
      isFetching: false,
      isError: false,
      refetch: refetchOrganizationMock,
    } as unknown as ReturnType<typeof useOrganization>;
    vi.mocked(useOrganization).mockReturnValue(query);
    const { rerender } = render(<ConnectionPage />);
    fireEvent.change(screen.getByLabelText("Selected gateway"), {
      target: { value: "Chosen gateway" },
    });

    vi.mocked(useOrganization).mockReturnValue({ ...query, isFetching: true });
    rerender(<ConnectionPage />);
    expect(screen.getByTestId("connection-flow")).not.toBeVisible();
    expect(connectionFlowMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        skillsEnabled: true,
        llmProxyEnabled: true,
        pluginsEnabled: true,
      }),
    );

    vi.mocked(useOrganization).mockReturnValue(query);
    rerender(<ConnectionPage />);
    expect(screen.getByTestId("connection-flow")).toBeVisible();
    expect(screen.getByLabelText("Selected gateway")).toHaveValue(
      "Chosen gateway",
    );
  });

  it("offers retry instead of a partial setup when settings cannot be verified", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: {
        connectionSkillsEnabled: true,
        connectionLlmProxyEnabled: true,
        connectionPluginsEnabled: true,
      },
      isFetchedAfterMount: true,
      isFetching: false,
      isError: true,
      refetch: refetchOrganizationMock,
    } as unknown as ReturnType<typeof useOrganization>);
    render(<ConnectionPage />);
    expect(connectionFlowMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetchOrganizationMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes organization settings when the Connect tab visibility changes", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
      isFetchedAfterMount: true,
      isFetching: false,
      isError: false,
      refetch: refetchOrganizationMock,
    } as unknown as ReturnType<typeof useOrganization>);

    render(<ConnectionPage />);
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    expect(refetchOrganizationMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed for plugins while preserving a non-plugin Connect flow", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: {
        connectionSkillsEnabled: true,
        connectionLlmProxyEnabled: true,
        connectionPluginsEnabled: false,
      },
      isFetchedAfterMount: true,
      isFetching: false,
      isError: false,
      refetch: refetchOrganizationMock,
    } as unknown as ReturnType<typeof useOrganization>);

    render(<ConnectionPage />);

    expect(connectionFlowMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ pluginsEnabled: false }),
    );
  });
});
