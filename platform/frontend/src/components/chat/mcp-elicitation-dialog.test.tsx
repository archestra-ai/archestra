import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { McpElicitationDialog } from "./mcp-elicitation-dialog";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

const request = {
  id: "00000000-0000-4000-8000-000000000001",
  conversationId: "00000000-0000-4000-8000-000000000002",
  toolName: "delivery__collect_delivery_details",
  message: "Please confirm delivery details",
  mode: "form" as const,
  requestedSchema: {
    type: "object",
    properties: {
      recipient_name: {
        type: "string",
        title: "Recipient Name",
        description: "Who should receive it?",
      },
      delivery_window: {
        type: "string",
        title: "Delivery Window",
        enum: ["morning", "afternoon"],
      },
      fragile: {
        type: "boolean",
        title: "Fragile",
        default: true,
      },
      quantity: {
        type: "integer",
        title: "Quantity",
      },
    },
    required: ["recipient_name", "delivery_window", "quantity"],
  },
};

describe("McpElicitationDialog", () => {
  it("blocks accept when required fields are empty", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();

    render(
      <McpElicitationDialog
        request={request}
        isSubmitting={false}
        onRespond={onRespond}
      />,
    );

    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByText("Recipient Name is required.")).toBeInTheDocument();
    expect(screen.getByText("Quantity is required.")).toBeInTheDocument();
  });

  it("submits normalized content when required fields are provided", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn().mockResolvedValue(undefined);

    render(
      <McpElicitationDialog
        request={request}
        isSubmitting={false}
        onRespond={onRespond}
      />,
    );

    await user.type(
      screen.getByRole("textbox", { name: /recipient name/i }),
      "Avery Test",
    );
    await user.type(screen.getByRole("spinbutton", { name: /quantity/i }), "3");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(onRespond).toHaveBeenCalledWith({
      id: request.id,
      action: "accept",
      content: {
        recipient_name: "Avery Test",
        delivery_window: "morning",
        fragile: true,
        quantity: 3,
      },
    });
  });
});
