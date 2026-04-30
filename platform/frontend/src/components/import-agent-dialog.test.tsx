/**
 * Unit tests for the ImportAgentDialog component.
 *
 * Tests:
 * - Initial render shows file picker and paste mode toggle
 * - Mode toggle switches between file picker and paste textarea
 * - Uploading valid JSON shows the agent preview
 * - Uploading invalid JSON shows an error alert
 * - Uploading a payload with unsupported version shows an error
 * - Uploading a non-agent type shows an error
 * - Import button is NOT shown until valid JSON is parsed
 * - "Back" button returns from preview to the picker
 * - Import button triggers the mutation and shows success state
 * - Warnings are displayed after import with warnings
 * - "Cancel" button calls onOpenChange(false)
 * - "Done" button calls onOpenChange(false) after success
 * - Paste mode: Parse JSON button parses pasted content
 * - Paste mode: Parse JSON button is disabled for empty content
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportAgentDialog } from "./import-agent-dialog";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mutateAsync = vi.fn();

vi.mock("@/lib/agent.query", () => ({
  useImportAgent: () => ({
    mutateAsync,
    isPending: false,
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validPayload = {
  version: "1",
  exportedAt: new Date().toISOString(),
  sourceInstance: null,
  agent: {
    name: "Test Import Agent",
    agentType: "agent",
    description: "A test agent for import dialog",
    systemPrompt: "Be helpful",
    icon: "🤖",
    scope: "personal",
    considerContextUntrusted: false,
    toolAssignmentMode: "manual",
    toolExposureMode: "full",
    llmModel: "gpt-4o",
    incomingEmailEnabled: false,
    incomingEmailSecurityMode: "private",
    incomingEmailAllowedDomain: null,
    passthroughHeaders: null,
  },
  labels: [{ key: "env", value: "test" }],
  suggestedPrompts: [],
  tools: [
    {
      toolName: "web_search",
      catalogName: "Web Catalog",
      credentialResolutionMode: "dynamic",
    },
    {
      toolName: "code_exec",
      catalogName: "Dev Tools",
      credentialResolutionMode: "static",
    },
  ],
  delegations: [{ targetAgentName: "Sub Agent" }],
  knowledgeBases: [{ name: "Company Wiki" }],
  connectors: [{ name: "Confluence", connectorType: "confluence" }],
};

const validPayloadJson = JSON.stringify(validPayload);

const invalidJson = "{ this is not valid JSON }";

const unknownVersionPayload = JSON.stringify({
  ...validPayload,
  version: "99",
});

const gatewayPayload = JSON.stringify({
  ...validPayload,
  agent: { ...validPayload.agent, agentType: "mcp_gateway" },
});

/** Simulate a file upload on a hidden <input type="file"> element */
async function simulateFileUpload(
  user: ReturnType<typeof userEvent.setup>,
  content: string,
  filename = "agent-export.json",
) {
  const file = new File([content], filename, { type: "application/json" });
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  await user.upload(input, file);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ImportAgentDialog", () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({
      agent: {
        id: "agent-123",
        name: "Test Import Agent (imported)",
        agentType: "agent",
        scope: "personal",
        labels: [],
        suggestedPrompts: [],
        tools: [],
        knowledgeBaseIds: [],
        connectorIds: [],
      },
      warnings: [],
    });
  });

  it("renders the dialog with title, file picker, and mode toggle when open", () => {
    render(<ImportAgentDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByText("Import Agent")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /upload file/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /paste json/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/drag and drop/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("does not render when open is false", () => {
    render(<ImportAgentDialog open={false} onOpenChange={vi.fn()} />);

    expect(screen.queryByText("Import Agent")).not.toBeInTheDocument();
  });

  it("switches to paste mode when 'Paste JSON' button is clicked", async () => {
    const user = userEvent.setup();
    render(<ImportAgentDialog open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /paste json/i }));

    expect(
      screen.getByPlaceholderText(/paste agent json here/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /parse json/i }),
    ).toBeInTheDocument();
    // File picker should be gone
    expect(screen.queryByText(/drag and drop/i)).not.toBeInTheDocument();
  });

  it("Parse JSON button is disabled when paste area is empty", async () => {
    const user = userEvent.setup();
    render(<ImportAgentDialog open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /paste json/i }));

    const parseBtn = screen.getByRole("button", { name: /parse json/i });
    expect(parseBtn).toBeDisabled();
  });

  it("shows agent preview after uploading valid JSON file", async () => {
    const user = userEvent.setup();
    render(<ImportAgentDialog open onOpenChange={vi.fn()} />);

    await simulateFileUpload(user, validPayloadJson);

    await waitFor(() => {
      expect(screen.getByText("Ready to Import")).toBeInTheDocument();
    });

    // Agent name shown in preview
    expect(screen.getByText("Test Import Agent")).toBeInTheDocument();

    // Association counts
    expect(screen.getByText(/2 tools/i)).toBeInTheDocument();
    expect(screen.getByText(/1 delegation/i)).toBeInTheDocument();
    expect(screen.getByText(/1 knowledge base/i)).toBeInTheDocument();
    expect(screen.getByText(/1 connector/i)).toBeInTheDocument();

    // LLM model informational
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();

    // Import button is now shown
    expect(
      screen.getByRole("button", { name: /import agent/i }),
    ).toBeInTheDocument();
  });

  it("shows error alert for invalid JSON", async () => {
    const user = userEvent.setup();
    render(<ImportAgentDialog open onOpenChange={vi.fn()} />);

    await simulateFileUpload(user, invalidJson);

    await waitFor(() => {
      expect(screen.getByText("Invalid Configuration")).toBeInTheDocument();
      expect(screen.getByText(/invalid json file/i)).toBeInTheDocument();
    });

    // Import button must NOT be shown
    expect(
      screen.queryByRole("button", { name: /import agent/i }),
    ).not.toBeInTheDocument();
  });

  it("shows error for unsupported version number", async () => {
    const user = userEvent.setup();
    render(<ImportAgentDialog open onOpenChange={vi.fn()} />);

    await simulateFileUpload(user, unknownVersionPayload);

    await waitFor(() => {
      expect(screen.getByText(/unsupported version/i)).toBeInTheDocument();
    });
  });

  it("shows error for non-agent agentType (mcp_gateway)", async () => {
    const user = userEvent.setup();
    render(<ImportAgentDialog open onOpenChange={vi.fn()} />);

    await simulateFileUpload(user, gatewayPayload);

    await waitFor(() => {
      expect(
        screen.getByText(/only internal agents can be imported/i),
      ).toBeInTheDocument();
    });
  });

  it("'Back' button returns from preview to idle state", async () => {
    const user = userEvent.setup();
    render(<ImportAgentDialog open onOpenChange={vi.fn()} />);

    await simulateFileUpload(user, validPayloadJson);
    await waitFor(() => screen.getByText("Ready to Import"));

    await user.click(screen.getByRole("button", { name: /back/i }));

    // Should be back to the file picker
    expect(screen.getByText(/drag and drop/i)).toBeInTheDocument();
    expect(screen.queryByText("Ready to Import")).not.toBeInTheDocument();
  });

  it("calls mutateAsync and shows success state after import", async () => {
    const user = userEvent.setup();
    render(<ImportAgentDialog open onOpenChange={vi.fn()} />);

    await simulateFileUpload(user, validPayloadJson);
    await waitFor(() => screen.getByRole("button", { name: /import agent/i }));

    await user.click(screen.getByRole("button", { name: /import agent/i }));

    expect(mutateAsync).toHaveBeenCalledOnce();

    await waitFor(() => {
      expect(
        screen.getByText("Agent Imported Successfully"),
      ).toBeInTheDocument();
      expect(screen.getByText(/has been created with/i)).toBeInTheDocument();
    });

    // Done button appears
    expect(screen.getByRole("button", { name: /done/i })).toBeInTheDocument();
  });

  it("displays import warnings after a successful import with warnings", async () => {
    mutateAsync.mockResolvedValueOnce({
      agent: {
        id: "agent-456",
        name: "Warned Agent",
        agentType: "agent",
        scope: "personal",
        labels: [],
        suggestedPrompts: [],
        tools: [],
        knowledgeBaseIds: [],
        connectorIds: [],
      },
      warnings: [
        {
          type: "tool",
          name: "web_search",
          message: 'Tool "web_search" not found in catalog "Web Catalog".',
        },
        {
          type: "knowledgeBase",
          name: "Company Wiki",
          message:
            'Knowledge base "Company Wiki" not found in this organization.',
        },
      ],
    });

    const user = userEvent.setup();
    render(<ImportAgentDialog open onOpenChange={vi.fn()} />);

    await simulateFileUpload(user, validPayloadJson);
    await waitFor(() => screen.getByRole("button", { name: /import agent/i }));

    await user.click(screen.getByRole("button", { name: /import agent/i }));

    await waitFor(() => {
      expect(screen.getByText(/2 warnings/i)).toBeInTheDocument();
      expect(screen.getByText(/web_search/i)).toBeInTheDocument();
      expect(screen.getByText(/company wiki/i)).toBeInTheDocument();
    });
  });

  it("calls onSuccess callback with agent data and warning count", async () => {
    const onSuccess = vi.fn();
    const user = userEvent.setup();
    render(
      <ImportAgentDialog open onOpenChange={vi.fn()} onSuccess={onSuccess} />,
    );

    await simulateFileUpload(user, validPayloadJson);
    await waitFor(() => screen.getByRole("button", { name: /import agent/i }));

    await user.click(screen.getByRole("button", { name: /import agent/i }));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith(
        { id: "agent-123", name: "Test Import Agent (imported)" },
        0,
      );
    });
  });

  it("'Cancel' button calls onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<ImportAgentDialog open onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("'Done' button calls onOpenChange(false) after successful import", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<ImportAgentDialog open onOpenChange={onOpenChange} />);

    await simulateFileUpload(user, validPayloadJson);
    await waitFor(() => screen.getByRole("button", { name: /import agent/i }));

    await user.click(screen.getByRole("button", { name: /import agent/i }));
    await waitFor(() => screen.getByRole("button", { name: /done/i }));

    await user.click(screen.getByRole("button", { name: /done/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("parses pasted JSON and shows preview in paste mode", async () => {
    const user = userEvent.setup();
    render(<ImportAgentDialog open onOpenChange={vi.fn()} />);

    // Switch to paste mode
    await user.click(screen.getByRole("button", { name: /paste json/i }));

    // Type valid JSON into the textarea
    const textarea = screen.getByPlaceholderText(/paste agent json here/i);
    await user.type(
      textarea,
      JSON.stringify({
        ...validPayload,
        agent: { ...validPayload.agent, name: "Pasted Agent" },
      }),
    );

    // Parse JSON button should be enabled now
    const parseBtn = screen.getByRole("button", { name: /parse json/i });
    expect(parseBtn).not.toBeDisabled();

    await user.click(parseBtn);

    await waitFor(() => {
      expect(screen.getByText("Ready to Import")).toBeInTheDocument();
      expect(screen.getByText("Pasted Agent")).toBeInTheDocument();
    });
  });
});
