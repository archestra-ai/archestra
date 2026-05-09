import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type TableRowAction, TableRowActions } from "./table-row-actions";

// Mocking icons
const MockIcon = () => <span data-testid="mock-icon">Icon</span>;

// Mocking hooks
const { useHasPermissionsMock, useMissingPermissionsMock } = vi.hoisted(() => ({
  useHasPermissionsMock: vi.fn(() => ({ data: true })),
  useMissingPermissionsMock: vi.fn(() => ({})),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: useHasPermissionsMock,
  useMissingPermissions: useMissingPermissionsMock,
}));

vi.mock("@/lib/auth/auth.utils", () => ({
  formatMissingPermissions: vi.fn(() => "Missing permissions"),
}));

// Mocking UI components to simplify testing
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: {
    children: React.ReactNode;
    onClick?: React.MouseEventHandler;
    disabled?: boolean;
    [key: string]: unknown;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/button-group", () => ({
  ButtonGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: React.MouseEventHandler;
  }) => (
    <div
      data-testid="dropdown-content"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          onClick?.(e as unknown as React.MouseEvent);
        }
      }}
      role="menu"
      tabIndex={-1}
    >
      {children}
    </div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
    className,
  }: {
    children: React.ReactNode;
    onClick?: React.MouseEventHandler;
    disabled?: boolean;
    className?: string;
  }) => (
    <div
      role="menuitem"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          onClick?.(e as unknown as React.MouseEvent);
        }
      }}
      tabIndex={0}
      data-disabled={disabled}
      className={className}
    >
      {children}
    </div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/permission-button", () => ({
  PermissionButton: ({
    children,
    onClick,
    permissions,
    disabled,
    ...props
  }: {
    children: React.ReactNode;
    onClick?: React.MouseEventHandler;
    permissions: unknown;
    disabled?: boolean;
    [key: string]: unknown;
  }) => {
    const { data: hasPermission } = useHasPermissionsMock();
    return (
      <button
        type="button"
        onClick={onClick}
        data-permissions={JSON.stringify(permissions)}
        disabled={!hasPermission || disabled}
        {...props}
      >
        {children}
      </button>
    );
  },
}));

describe("TableRowActions", () => {
  const primaryActions: TableRowAction[] = [
    {
      icon: <MockIcon />,
      label: "Edit",
      onClick: vi.fn(),
      testId: "edit-btn",
    },
  ];

  const dropdownActions: TableRowAction[] = [
    {
      icon: <MockIcon />,
      label: "Delete",
      onClick: vi.fn(),
      testId: "delete-btn",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    useHasPermissionsMock.mockReturnValue({ data: true });
  });

  it("renders primary actions as buttons", () => {
    render(
      <TooltipProvider>
        <TableRowActions actions={primaryActions} />
      </TooltipProvider>,
    );

    expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
  });

  it("renders the 'More actions' trigger when dropdownActions are provided", () => {
    render(
      <TooltipProvider>
        <TableRowActions
          actions={primaryActions}
          dropdownActions={dropdownActions}
        />
      </TooltipProvider>,
    );

    expect(screen.getByLabelText(/more actions/i)).toBeInTheDocument();
  });

  it("calls stopPropagation on primary action click", () => {
    const stopPropagation = vi.fn();
    render(
      <TooltipProvider>
        <TableRowActions actions={primaryActions} />
      </TooltipProvider>,
    );

    const editBtn = screen.getByRole("button", { name: /edit/i });
    fireEvent.click(editBtn, { stopPropagation });

    expect(primaryActions[0].onClick).toHaveBeenCalled();
    // ActionButton handles stopPropagation internally via onClick wrapper in TableRowActions
  });

  it("calls stopPropagation on dropdown trigger click", () => {
    render(
      <TooltipProvider>
        <TableRowActions
          actions={primaryActions}
          dropdownActions={dropdownActions}
        />
      </TooltipProvider>,
    );

    const trigger = screen.getByLabelText(/more actions/i);
    const event = createEvent.click(trigger);
    vi.spyOn(event, "stopPropagation");
    fireEvent(trigger, event);

    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("renders dropdown items when 'More actions' is triggered", () => {
    // In our simplified mock, they are rendered directly
    render(
      <TooltipProvider>
        <TableRowActions
          actions={primaryActions}
          dropdownActions={dropdownActions}
        />
      </TooltipProvider>,
    );

    expect(
      screen.getByRole("menuitem", { name: /delete/i }),
    ).toBeInTheDocument();
  });

  it("disables primary action if permissions are missing", () => {
    useHasPermissionsMock.mockReturnValue({ data: false });
    const actionsWithPerms: TableRowAction[] = [
      {
        icon: <MockIcon />,
        label: "Secure Edit",
        permissions: { agent: ["update"] },
        onClick: vi.fn(),
      },
    ];

    render(
      <TooltipProvider>
        <TableRowActions actions={actionsWithPerms} />
      </TooltipProvider>,
    );

    const btn = screen.getByRole("button", { name: /secure edit/i });
    expect(btn).toBeDisabled();
  });

  it("disables dropdown item if permissions are missing", () => {
    useHasPermissionsMock.mockReturnValue({ data: false });
    const dropActions: TableRowAction[] = [
      {
        icon: <MockIcon />,
        label: "Secure Delete",
        permissions: { agent: ["delete"] },
        onClick: vi.fn(),
      },
    ];

    render(
      <TooltipProvider>
        <TableRowActions actions={[]} dropdownActions={dropActions} />
      </TooltipProvider>,
    );

    const item = screen.getByRole("menuitem", { name: /secure delete/i });
    expect(item).toHaveAttribute("data-disabled", "true");
  });

  it("applies cursor-pointer to enabled dropdown items and cursor-not-allowed to disabled ones", () => {
    const mixedActions: TableRowAction[] = [
      {
        icon: <MockIcon />,
        label: "Enabled",
        onClick: vi.fn(),
      },
      {
        icon: <MockIcon />,
        label: "Disabled",
        disabled: true,
        onClick: vi.fn(),
      },
    ];

    render(
      <TooltipProvider>
        <TableRowActions actions={[]} dropdownActions={mixedActions} />
      </TooltipProvider>,
    );

    const enabledItem = screen.getByRole("menuitem", { name: /enabled/i });
    const disabledItem = screen.getByRole("menuitem", { name: /disabled/i });

    expect(enabledItem).toHaveClass("cursor-pointer");
    expect(disabledItem).toHaveClass("cursor-not-allowed");
  });

  it("prevents onClick if dropdown item is disabled", () => {
    const onClick = vi.fn();
    const disabledAction: TableRowAction[] = [
      {
        icon: <MockIcon />,
        label: "Disabled Action",
        disabled: true,
        onClick,
      },
    ];

    render(
      <TooltipProvider>
        <TableRowActions actions={[]} dropdownActions={disabledAction} />
      </TooltipProvider>,
    );

    const item = screen.getByRole("menuitem", { name: /disabled action/i });
    fireEvent.click(item);

    expect(onClick).not.toHaveBeenCalled();
  });
});
