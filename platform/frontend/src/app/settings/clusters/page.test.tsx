"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

const mockUseClusters = vi.fn();
const mockUseCreateCluster = vi.fn();
const mockUseUpdateCluster = vi.fn();
const mockUseDeleteCluster = vi.fn();
const mockUseTestCluster = vi.fn();

const createMutate = vi.fn();
const updateMutate = vi.fn();
const deleteMutate = vi.fn();
const testMutate = vi.fn();

type MockCluster = {
  id: string;
  name: string;
  namespace: string | null;
  kubeconfigSecretId: string | null;
  loadFromCluster: boolean;
  isDefault: boolean;
  isPersonalDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

const defaultCluster: MockCluster = {
  id: "cluster-default",
  name: "default",
  namespace: "archestra",
  kubeconfigSecretId: null,
  loadFromCluster: true,
  isDefault: true,
  isPersonalDefault: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const personalCluster: MockCluster = {
  id: "cluster-personal",
  name: "my-laptop",
  namespace: "default",
  kubeconfigSecretId: "secret-1",
  loadFromCluster: false,
  isDefault: false,
  isPersonalDefault: true,
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

vi.mock("@/lib/clusters/cluster.query", () => ({
  useClusters: () => mockUseClusters(),
  useCreateCluster: () => mockUseCreateCluster(),
  useUpdateCluster: () => mockUseUpdateCluster(),
  useDeleteCluster: () => mockUseDeleteCluster(),
  useTestCluster: () => mockUseTestCluster(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock("@/app/settings/layout", () => ({
  useSetSettingsAction: () => () => {},
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true, isPending: false }),
  useMissingPermissions: () => [],
}));

import ClustersSettingsPage from "./page";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ClustersSettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  createMutate.mockReset();
  updateMutate.mockReset();
  deleteMutate.mockReset();
  testMutate.mockReset();

  mockUseClusters.mockReturnValue({
    data: [defaultCluster, personalCluster],
    isLoading: false,
  });
  mockUseCreateCluster.mockReturnValue({
    mutate: createMutate,
    mutateAsync: createMutate,
    isPending: false,
  });
  mockUseUpdateCluster.mockReturnValue({
    mutate: updateMutate,
    mutateAsync: updateMutate,
    isPending: false,
  });
  mockUseDeleteCluster.mockReturnValue({
    mutate: deleteMutate,
    mutateAsync: deleteMutate,
    isPending: false,
  });
  mockUseTestCluster.mockReturnValue({
    mutate: testMutate,
    mutateAsync: testMutate.mockResolvedValue({
      ok: true,
      namespacesVisible: 3,
    }),
    isPending: false,
    data: undefined,
  });
});

describe("ClustersSettingsPage", () => {
  it("renders all clusters returned by useClusters", () => {
    renderPage();

    expect(screen.getByText("default")).toBeInTheDocument();
    expect(screen.getByText("my-laptop")).toBeInTheDocument();
  });

  it("opens the create dialog when the Create cluster action is clicked", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      screen.getByRole("button", { name: /create cluster|add cluster/i }),
    );

    expect(
      await screen.findByRole("dialog", { name: /cluster/i }),
    ).toBeInTheDocument();
  });

  it("blocks submit when the cluster name is empty", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      screen.getByRole("button", { name: /create cluster|add cluster/i }),
    );
    const dialog = await screen.findByRole("dialog", { name: /cluster/i });
    await user.click(
      within(dialog).getByRole("button", { name: /^create$|^save$/i }),
    );

    expect(createMutate).not.toHaveBeenCalled();
  });

  it("submits a valid form by calling useCreateCluster.mutate", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      screen.getByRole("button", { name: /create cluster|add cluster/i }),
    );
    const dialog = await screen.findByRole("dialog", { name: /cluster/i });

    await user.type(within(dialog).getByLabelText(/name/i), "edge");
    const namespaceInput = within(dialog).queryByLabelText(/namespace/i);
    if (namespaceInput) {
      await user.type(namespaceInput, "edge-ns");
    }

    await user.click(
      within(dialog).getByRole("button", { name: /^create$|^save$/i }),
    );

    await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
    const submitted = createMutate.mock.calls[0][0];
    expect(submitted).toEqual(expect.objectContaining({ name: "edge" }));
  });

  it("opens an edit dialog with prefilled values when an existing row is clicked", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByText("my-laptop"));

    const dialog = await screen.findByRole("dialog", { name: /cluster/i });
    expect(within(dialog).getByLabelText(/name/i)).toHaveValue("my-laptop");
  });

  it("calls useTestCluster.mutate and surfaces the connection result", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByText("my-laptop"));
    const dialog = await screen.findByRole("dialog", { name: /cluster/i });
    await user.click(
      within(dialog).getByRole("button", { name: /test connection/i }),
    );

    await waitFor(() =>
      expect(testMutate).toHaveBeenCalledWith("cluster-personal"),
    );
  });

  it("requires confirmation before deleting a cluster", async () => {
    const user = userEvent.setup();
    renderPage();

    const personalRow = screen.getByText("my-laptop").closest("tr");
    expect(personalRow).not.toBeNull();
    await user.click(
      within(personalRow as HTMLElement).getByRole("button", {
        name: /delete/i,
      }),
    );

    const confirm = await screen.findByRole("dialog", { name: /delete/i });
    await user.click(
      within(confirm).getByRole("button", { name: /^delete$/i }),
    );

    await waitFor(() =>
      expect(deleteMutate).toHaveBeenCalledWith("cluster-personal"),
    );
  });

  it("renders a Default badge and disables delete on the default cluster", () => {
    renderPage();

    const defaultRow = screen.getByText("default").closest("tr");
    expect(defaultRow).not.toBeNull();
    expect(
      within(defaultRow as HTMLElement).getByText(/default/i),
    ).toBeInTheDocument();

    const deleteButton = within(defaultRow as HTMLElement).queryByRole(
      "button",
      { name: /delete/i },
    );
    if (deleteButton) {
      expect(deleteButton).toBeDisabled();
    }
  });

  it("exposes a personal-default toggle on each cluster row", () => {
    renderPage();

    const personalRow = screen.getByText("my-laptop").closest("tr");
    expect(personalRow).not.toBeNull();
    expect(
      within(personalRow as HTMLElement).getByRole("switch", {
        name: /personal default|default for me/i,
      }),
    ).toBeInTheDocument();
  });
});
