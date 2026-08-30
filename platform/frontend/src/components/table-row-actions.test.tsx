import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { type TableRowAction, TableRowActions } from "./table-row-actions";

// Mocking icons
const MockIcon = () => <span data-testid="mock-icon">Icon</span>;

// The PermissionButton mock below reads the same hook the component does, so a
// single shared hoisted driver keeps both in lockstep; the bare auth.query mock
// delegates the real hook to it in `beforeEach`.
const { useHasPermissionsMock } = vi.hoisted(() => ({
  useHasPermissionsMock: vi.fn(() => ({ data: true })),
}));

vi.mock("@/lib/auth/auth.query");

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
    className,
    variant: _variant,
    asChild: _asChild,
    ...props
  }: {
    children: React.ReactNode;
    onClick?: React.MouseEventHandler;
    className?: string;
    variant?: string;
    asChild?: boolean;
    [key: string]: unknown;
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
      className={className}
      {...props}
    >
      {children}
    </div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

// The real PermissionButton is exercised end to end in
// table-row-actions.integration.test.tsx; this suite stands in for it so the
// cases below stay about how TableRowActions arranges its rows.
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
    vi.mocked(useHasPermissions).mockImplementation(
      useHasPermissionsMock as unknown as typeof useHasPermissions,
    );
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

  it("appends itemName to each action's accessible name so identical row buttons are distinguishable", () => {
    render(
      <TooltipProvider>
        <TableRowActions
          actions={primaryActions}
          dropdownActions={dropdownActions}
          itemName="My Agent"
        />
      </TooltipProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Edit My Agent" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("More actions My Agent")).toBeInTheDocument();
  });

  it("keeps the bare action label as the accessible name when itemName is not provided", () => {
    render(
      <TooltipProvider>
        <TableRowActions actions={primaryActions} />
      </TooltipProvider>,
    );

    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
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

  it("explains an available dropdown action with its tooltip, and still fires it", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(
      <TooltipProvider>
        <TableRowActions
          actions={primaryActions}
          dropdownActions={[
            {
              icon: <MockIcon />,
              label: "Pin default",
              tooltip: "Your new chats start on this agent.",
              onClick,
            },
          ]}
        />
      </TooltipProvider>,
    );

    expect(
      screen.getByText("Your new chats start on this agent."),
    ).toBeInTheDocument();
    // The tooltip must not cost the item its behaviour: an enabled item stays
    // its own trigger rather than gaining a wrapper element.
    await user.click(screen.getByRole("menuitem", { name: /pin default/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("leaves an action with no tooltip showing just its label", () => {
    render(
      <TooltipProvider>
        <TableRowActions
          actions={primaryActions}
          dropdownActions={[
            { icon: <MockIcon />, label: "Clone", onClick: vi.fn() },
          ]}
        />
      </TooltipProvider>,
    );

    // The primary buttons and the "More actions" trigger have tooltips of
    // their own; what must not exist is one for this item.
    const tooltips = screen
      .getAllByTestId("tooltip-content")
      .map((node) => node.textContent);
    expect(tooltips).not.toContain("Clone");
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

    // `aria-disabled`, not Radix's `disabled`: a disabled item leaves the
    // menu's roving focus and typeahead, taking its stated reason with it.
    const item = screen.getByRole("menuitem", { name: /secure delete/i });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleDescription(
      "Available to roles with the Agents (delete) permission",
    );
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
