import { fireEvent, render, screen, within } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useFeature } from "@/lib/config/config.query";
import {
  useBulkDeleteEnvironments,
  useCreateEnvironment,
  useDeleteEnvironment,
  useEnvironments,
  useK8sCapabilities,
  useUpdateEnvironment,
} from "@/lib/environment.query";
import {
  useDefaultEnvironment,
  useOrganization,
  useUpdateDefaultEnvironment,
} from "@/lib/organization.query";
import {
  EnvironmentsSection,
  NetworkPolicyFields,
} from "./environments-section";

vi.mock("next/navigation");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/environment.query", () => ({
  useBulkDeleteEnvironments: vi.fn(),
  useCreateEnvironment: vi.fn(),
  useDeleteEnvironment: vi.fn(),
  useEnvironments: vi.fn(),
  useK8sCapabilities: vi.fn(),
  useUpdateEnvironment: vi.fn(),
}));

vi.mock("@/components/search-input", () => ({
  SearchInput: ({
    placeholder,
    value,
    onSearchChange,
  }: {
    placeholder?: string;
    value: string;
    onSearchChange: (value: string) => void;
  }) => (
    <input
      aria-label={placeholder}
      value={value}
      onChange={(event) => onSearchChange(event.target.value)}
    />
  ),
}));

vi.mock("@/components/filter-bar", () => ({
  CollectionFilters: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  FilterBar: ({
    children,
    onClearFilters,
  }: {
    children: React.ReactNode;
    onClearFilters?: () => void;
  }) => (
    <div>
      {children}
      {onClearFilters ? (
        <button type="button" onClick={onClearFilters}>
          Clear filters
        </button>
      ) : null}
    </div>
  ),
  FilterSelect: ({
    value,
    onValueChange,
    placeholder,
    items,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    placeholder: string;
    items: Array<{ value: string; label: string }>;
  }) => (
    <select
      aria-label={placeholder}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  ),
  filterSearchClass: "",
}));

vi.mock("@/components/ui/data-table", () => ({
  DataTable: ({
    data,
    filteredEmptyMessage,
  }: {
    data: Array<{ id: string; name: string }>;
    filteredEmptyMessage: string;
  }) => (
    <div data-testid="environment-table">
      {data.length > 0
        ? data.map((row) => <div key={row.id}>{row.name}</div>)
        : filteredEmptyMessage}
    </div>
  ),
}));

vi.mock("@/components/ui/bulk-actions-bar", () => ({
  BulkActions: () => null,
}));
vi.mock("@/components/ui/bulk-actions-context", () => ({
  BulkActionsScope: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@/components/form-dialog", () => ({
  FormDialog: ({
    open,
    title,
    description,
    children,
  }: {
    open: boolean;
    title: React.ReactNode;
    description?: React.ReactNode;
    children: React.ReactNode;
  }) =>
    open ? (
      <section role="dialog" aria-label={String(title)}>
        <div data-testid="dialog-description">{description}</div>
        {children}
      </section>
    ) : null,
}));
vi.mock("@/components/delete-confirm-dialog", () => ({
  DeleteConfirmDialog: () => null,
}));
vi.mock("./environment-resource-defaults-dialog", () => ({
  EnvironmentResourceDefaultsDialog: () => null,
}));

const mutation = { mutate: vi.fn(), isPending: false };
const publicInternetPolicy = {
  egressMode: "unrestricted" as const,
  domainPreset: "none" as const,
  allowedDomains: [],
  allowedCidrs: [],
};

describe("EnvironmentsSection filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/settings/environments");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useFeature).mockImplementation((feature) =>
      feature === "environmentNamespaces" ? [] : false,
    );
    vi.mocked(useOrganization).mockReturnValue({
      isSuccess: true,
    } as ReturnType<typeof useOrganization>);
    vi.mocked(useDefaultEnvironment).mockReturnValue({
      name: "Default",
      namespace: "archestra",
      description: null,
      networkPolicy: publicInternetPolicy,
      restricted: false,
      validationRegex: null,
      trustedImageRegistries: null,
    });
    vi.mocked(useEnvironments).mockReturnValue({
      data: {
        environments: [
          makeEnvironment({
            id: "internal",
            name: "Internal tools",
            namespace: "private-services",
            networkPolicy: {
              egressMode: "restricted",
              domainPreset: "none",
              allowedDomains: [],
              allowedCidrs: ["10.0.0.0/8"],
            },
          }),
          makeEnvironment({
            id: "public",
            name: "Public tools",
            namespace: "internet-services",
            networkPolicy: publicInternetPolicy,
          }),
          makeEnvironment({
            id: "inherited",
            name: "Inherited policy",
            namespace: "shared-services",
            networkPolicy: null,
          }),
          makeEnvironment({
            id: "offline",
            name: "Offline",
            namespace: "isolated",
            networkPolicy: {
              egressMode: "off",
              domainPreset: "none",
              allowedDomains: [],
              allowedCidrs: [],
            },
          }),
        ],
        defaultAssignedCatalogCount: 0,
      },
      isFetching: false,
    } as unknown as ReturnType<typeof useEnvironments>);
    vi.mocked(useK8sCapabilities).mockReturnValue({
      data: undefined,
    } as ReturnType<typeof useK8sCapabilities>);
    vi.mocked(useBulkDeleteEnvironments).mockReturnValue(
      mutation as unknown as ReturnType<typeof useBulkDeleteEnvironments>,
    );
    vi.mocked(useCreateEnvironment).mockReturnValue(
      mutation as unknown as ReturnType<typeof useCreateEnvironment>,
    );
    vi.mocked(useUpdateEnvironment).mockReturnValue(
      mutation as unknown as ReturnType<typeof useUpdateEnvironment>,
    );
    vi.mocked(useDeleteEnvironment).mockReturnValue(
      mutation as unknown as ReturnType<typeof useDeleteEnvironment>,
    );
    vi.mocked(useUpdateDefaultEnvironment).mockReturnValue(
      mutation as unknown as ReturnType<typeof useUpdateDefaultEnvironment>,
    );
  });

  test("searches the visible name and namespace fields", () => {
    render(<EnvironmentsSection canEdit />);

    fireEvent.change(
      screen.getByRole("textbox", {
        name: "Search by name or namespace",
      }),
      { target: { value: "private-services" } },
    );

    const table = within(screen.getByTestId("environment-table"));
    expect(table.getByText("Internal tools")).toBeInTheDocument();
    expect(table.queryByText("Default")).not.toBeInTheDocument();
    expect(table.queryByText("Public tools")).not.toBeInTheDocument();
  });

  test("filters inherited policies by their effective egress mode", () => {
    render(<EnvironmentsSection canEdit />);

    fireEvent.change(
      screen.getByRole("combobox", { name: "Filter by network egress" }),
      { target: { value: "unrestricted" } },
    );

    const table = within(screen.getByTestId("environment-table"));
    expect(table.getByText("Default")).toBeInTheDocument();
    expect(table.getByText("Public tools")).toBeInTheDocument();
    expect(table.getByText("Inherited policy")).toBeInTheDocument();
    expect(table.queryByText("Internal tools")).not.toBeInTheDocument();
    expect(table.queryByText("Offline")).not.toBeInTheDocument();
  });

  test("keeps infrequently used environment controls collapsed", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("create=1") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    vi.mocked(useFeature).mockImplementation((feature) => {
      if (feature === "environmentNamespaces") return [];
      if (feature === "orchestratorK8sRuntime") return true;
      return false;
    });

    render(<EnvironmentsSection canEdit />);

    expect(
      within(screen.getByTestId("dialog-description")).getByRole("link", {
        name: /Learn more/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/IPv4 or IPv6 CIDR ranges that workloads/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allowed CIDRs help" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Validation rule")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Trusted image registries"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));

    expect(screen.getByLabelText("Validation rule")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Trusted image registries"),
    ).toBeInTheDocument();
  });
});

describe("NetworkPolicyFields", () => {
  test("guides Public internet CIDR exceptions at the point of configuration", () => {
    render(
      <NetworkPolicyFields
        egressMode="unrestricted"
        setEgressMode={vi.fn()}
        domainPreset="none"
        setDomainPreset={vi.fn()}
        allowedDomainsText=""
        setAllowedDomainsText={vi.fn()}
        allowedCidrsText="10.20.0.0/16"
        setAllowedCidrsText={vi.fn()}
        supportsFqdn={false}
        enforcementStatus="verified-enforced"
        baselineLoaded
        disabled={false}
      />,
    );

    expect(screen.getByLabelText("Additional allowed CIDRs")).toBeEnabled();
    expect(
      screen.getByText(/allow in addition to public internet/),
    ).toBeInTheDocument();
    const floorLinks = screen.getAllByRole("link", {
      name: /View blocked ranges/,
    });
    expect(floorLinks).toHaveLength(2);
    for (const link of floorLinks) {
      expect(link).toHaveAttribute(
        "href",
        expect.stringContaining("#the-public-internet-floor"),
      );
    }
  });
});

function makeEnvironment(overrides: {
  id: string;
  name: string;
  namespace: string;
  networkPolicy: ReturnType<typeof useDefaultEnvironment>["networkPolicy"];
}) {
  return {
    organizationId: "organization-id",
    description: null,
    restricted: false,
    validationRegex: null,
    trustedImageRegistries: null,
    sortOrder: 0,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    assignedCatalogCount: 0,
    ...overrides,
  };
}
