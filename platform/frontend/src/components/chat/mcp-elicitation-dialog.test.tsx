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
      insurance_value: {
        type: "number",
        title: "Insurance Value",
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
    expect(onRespond.mock.calls[0]?.[0].content).not.toHaveProperty(
      "insurance_value",
    );
  });

  it("renders only http and https URLs for url-mode requests", () => {
    const onRespond = vi.fn();
    const urlRequest = {
      ...request,
      mode: "url" as const,
      url: "https://example.com/authorize",
      requestedSchema: undefined,
    };

    const { rerender } = render(
      <McpElicitationDialog
        request={urlRequest}
        isSubmitting={false}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByRole("link", { name: "Open request" })).toHaveAttribute(
      "href",
      "https://example.com/authorize",
    );

    rerender(
      <McpElicitationDialog
        request={{ ...urlRequest, url: "javascript:alert(1)" }}
        isSubmitting={false}
        onRespond={onRespond}
      />,
    );

    expect(
      screen.queryByRole("link", { name: "Open request" }),
    ).not.toBeInTheDocument();
  });

  it("renders a checkbox choice form for ask_user elicitation", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const choiceRequest = {
      id: request.id,
      conversationId: request.conversationId,
      toolName: "archestra__ask_user",
      message: "Accept this change for the rest of this session?",
      mode: "form" as const,
      requestedSchema: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            title: "Choice",
            enum: ["Accept for this session", "Do not accept"],
          },
        },
        required: ["choice"],
      },
    };

    render(
      <McpElicitationDialog
        variant="inline"
        request={choiceRequest}
        isSubmitting={false}
        onRespond={onRespond}
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("mcp-elicitation-card")).toBeInTheDocument();
    expect(
      screen.getByText("Accept this change for the rest of this session?"),
    ).toBeInTheDocument();
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /decline/i }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("radio", { name: "Accept for this session" }),
    );
    await user.click(screen.getByRole("button", { name: /send/i }));

    expect(onRespond).toHaveBeenCalledWith({
      id: request.id,
      action: "accept",
      content: { choice: "Accept for this session" },
    });
  });
});
