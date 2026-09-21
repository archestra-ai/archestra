import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { McpElicitationDialog } from "./mcp-elicitation-dialog";
import { isChoiceElicitationRequest } from "./mcp-elicitation-fields";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

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

// The runtime's review text, as the backend streams it for a held call.
const reviewText = [
  'APPA asks you to rule as the authority "operator".',
  "",
  "Tool: archestra__todo_write",
  "Arguments:",
  "{",
  '  "todos": [',
  '    { "id": 1, "content": "qa-hitl", "status": "pending" }',
  "  ]",
  "}",
  "",
  "What this ruling would cover:",
  "  (none)",
].join("\n");

const reviewRequest = {
  id: "00000000-0000-4000-8000-000000000003",
  conversationId: "00000000-0000-4000-8000-000000000002",
  toolName: "execute_remedy_plan",
  message: reviewText,
  mode: "form" as const,
  requestedSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["approve", "deny"],
        description: "Approve or deny this remedy plan",
      },
    },
    required: ["action"],
  },
  kind: "openappa_review" as const,
};

describe("McpElicitationDialog", () => {
  it("keeps typed enums out of the string-only inline choice card", () => {
    expect(
      isChoiceElicitationRequest({
        ...request,
        requestedSchema: {
          type: "object",
          properties: {
            quantity: { type: "integer", enum: [1, 2] },
          },
          required: ["quantity"],
        },
      }),
    ).toBe(false);
  });

  it("submits a selected numeric enum as its typed value", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const numericEnumRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          quantity: { type: "integer", enum: [1, 2] },
        },
        required: ["quantity"],
      },
    };

    render(
      <McpElicitationDialog
        request={numericEnumRequest}
        isSubmitting={false}
        onRespond={onRespond}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: /quantity/i }));
    await user.click(screen.getByRole("option", { name: "2" }));
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(onRespond).toHaveBeenCalledWith({
      id: request.id,
      action: "accept",
      content: { quantity: 2 },
    });
  });

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

  it("keeps focus in a string field as it grows past the long-text threshold", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();

    render(
      <McpElicitationDialog
        request={request}
        isSubmitting={false}
        onRespond={onRespond}
      />,
    );

    const recipient = screen.getByRole("textbox", {
      name: /recipient name/i,
    });
    await user.click(recipient);
    await user.type(recipient, "x".repeat(121));

    expect(document.activeElement).toBe(recipient);
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

  it("shows a review's tool and arguments as written, with no form to contradict the buttons", () => {
    render(
      <McpElicitationDialog
        request={reviewRequest}
        isSubmitting={false}
        onRespond={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Approval Required" }),
    ).toBeInTheDocument();
    // Line breaks survive, so the tool and each argument read on their own lines.
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "PRE" && element.textContent === reviewText,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("Action")).not.toBeInTheDocument();
  });

  it.each([
    {
      button: /approve/i,
      response: { action: "accept", content: { action: "approve" } },
    },
    { button: /decline/i, response: { action: "decline" } },
    { button: /^cancel$/i, response: { action: "cancel" } },
  ])("answers a review with the button pressed ($response.action)", async ({
    button,
    response,
  }) => {
    const user = userEvent.setup();
    const onRespond = vi.fn().mockResolvedValue(undefined);

    render(
      <McpElicitationDialog
        request={reviewRequest}
        isSubmitting={false}
        onRespond={onRespond}
      />,
    );
    await user.click(screen.getByRole("button", { name: button }));

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith({
      id: reviewRequest.id,
      ...response,
    });
  });

  it("renders a third-party request as a plain form even when its tool is named like the review tool", () => {
    render(
      <McpElicitationDialog
        request={{
          ...reviewRequest,
          toolName: "example__execute_remedy_plan",
          kind: undefined,
        }}
        isSubmitting={false}
        onRespond={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Additional Information" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /approve/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });
});
