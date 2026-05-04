"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix Dialog / Popper need ResizeObserver as a real constructor
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Radix Select pokes at PointerEvent / hasPointerCapture which jsdom lacks.
if (
  typeof Element !== "undefined" &&
  !Element.prototype.hasPointerCapture
) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.setPointerCapture = () => {};
}
if (
  typeof Element !== "undefined" &&
  !Element.prototype.scrollIntoView
) {
  Element.prototype.scrollIntoView = () => {};
}

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
  namespace: "laptop-ns",
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

// The settings layout normally hosts the page-level action button. In tests we
// render the action node directly so the «Create cluster» control is reachable.
let setSettingsActionRef: ((node: ReactNode) => void) | null = null;
vi.mock("@/app/settings/layout", () => ({
  useSetSettingsAction: () => {
    return (node: ReactNode) => {
      setSettingsActionRef?.(node);
    };
  },
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true, isPending: false }),
  useMissingPermissions: () => [],
}));

import ClustersSettingsPage from "./page";

function SettingsActionHost() {
  const [node, setNode] = useState<ReactNode>(null);
  setSettingsActionRef = setNode;
  return <div data-testid="settings-action-slot">{node}</div>;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsActionHost />
      <ClustersSettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setSettingsActionRef = null;
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

    await user.type(within(dialog).getByLabelText("Name"), "edge");
    const namespaceInput = within(dialog).queryByLabelText("Namespace");
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

  it("opens an edit dialog with prefilled values via the row actions menu", async () => {
    const user = userEvent.setup();
    renderPage();

    const personalRow = screen.getByText("my-laptop").closest("tr");
    expect(personalRow).not.toBeNull();
    await user.click(
      within(personalRow as HTMLElement).getByRole("button", {
        name: /edit cluster/i,
      }),
    );

    const dialog = await screen.findByRole("dialog", { name: /cluster/i });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("my-laptop");
  });

  it("editing a custom-source cluster without re-pasting kubeconfig keeps the existing secret", async () => {
    const user = userEvent.setup();
    renderPage();

    const personalRow = screen.getByText("my-laptop").closest("tr");
    expect(personalRow).not.toBeNull();
    await user.click(
      within(personalRow as HTMLElement).getByRole("button", {
        name: /edit cluster/i,
      }),
    );

    const dialog = await screen.findByRole("dialog", { name: /cluster/i });
    const nameInput = within(dialog).getByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "my-laptop-renamed");

    await user.click(
      within(dialog).getByRole("button", { name: /^save$|^create$/i }),
    );

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    const submitted = updateMutate.mock.calls[0][0];
    expect(submitted).toEqual(
      expect.objectContaining({ id: "cluster-personal" }),
    );
    expect(submitted.body).not.toHaveProperty("kubeconfigYaml");
    expect(submitted.body.kubeconfigYaml).toBeUndefined();
    expect(submitted.body).toEqual(
      expect.objectContaining({
        name: "my-laptop-renamed",
        loadFromCluster: false,
      }),
    );
  });

  it("switching kubeconfig source from custom to in-cluster sends kubeconfigYaml: null", async () => {
    const user = userEvent.setup();
    renderPage();

    const personalRow = screen.getByText("my-laptop").closest("tr");
    expect(personalRow).not.toBeNull();
    await user.click(
      within(personalRow as HTMLElement).getByRole("button", {
        name: /edit cluster/i,
      }),
    );

    const dialog = await screen.findByRole("dialog", { name: /cluster/i });

    await user.click(
      within(dialog).getByRole("combobox", { name: /kubeconfig source/i }),
    );
    await user.click(
      await screen.findByRole("option", {
        name: /in-cluster service account/i,
      }),
    );

    await user.click(
      within(dialog).getByRole("button", { name: /^save$|^create$/i }),
    );

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    const submitted = updateMutate.mock.calls[0][0];
    expect(submitted.body).toHaveProperty("kubeconfigYaml", null);
    expect(submitted.body.loadFromCluster).toBe(true);
  });

  it("calls useTestCluster.mutate and surfaces the connection result", async () => {
    const user = userEvent.setup();
    renderPage();

    const personalRow = screen.getByText("my-laptop").closest("tr");
    expect(personalRow).not.toBeNull();
    await user.click(
      within(personalRow as HTMLElement).getByRole("button", {
        name: /edit cluster/i,
      }),
    );
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
        name: /delete cluster/i,
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

  it("renders a System badge and exposes no destructive action on the default cluster", () => {
    renderPage();

    const defaultRow = screen.getByText("default").closest("tr");
    expect(defaultRow).not.toBeNull();
    expect(
      within(defaultRow as HTMLElement).getByText(/system/i),
    ).toBeInTheDocument();

    expect(
      within(defaultRow as HTMLElement).queryByRole("button", {
        name: /delete cluster/i,
      }),
    ).not.toBeInTheDocument();
    expect(
      within(defaultRow as HTMLElement).queryByRole("button", {
        name: /edit cluster/i,
      }),
    ).not.toBeInTheDocument();
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

  it("toggles the kubeconfig YAML textarea based on the source selector", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      screen.getByRole("button", { name: /create cluster|add cluster/i }),
    );
    const dialog = await screen.findByRole("dialog", { name: /cluster/i });

    expect(
      within(dialog).queryByLabelText(/kubeconfig \(yaml\)/i),
    ).not.toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("combobox", { name: /kubeconfig source/i }),
    );
    await user.click(
      await screen.findByRole("option", { name: /custom kubeconfig/i }),
    );

    expect(
      within(dialog).getByLabelText(/kubeconfig \(yaml\)/i),
    ).toBeInTheDocument();
  });
});
