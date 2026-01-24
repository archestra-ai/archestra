import { E2eTestId } from "@shared";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock ResizeObserver which is used by Radix UI components
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock all the complex dependencies
vi.mock("@/components/ai-elements/prompt-input", () => ({
  PromptInput: ({ children }: { children: React.ReactNode }) => (
    <form data-testid="prompt-input">{children}</form>
  ),
  PromptInputActionAddAttachments: ({ label }: { label: string }) => (
    <span>{label}</span>
  ),
  PromptInputActionMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="action-menu">{children}</div>
  ),
  PromptInputActionMenuContent: ({
    children,
  }: {
    children: React.ReactNode;
  }) => <div>{children}</div>,
  PromptInputActionMenuTrigger: ({
    children,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    "data-testid"?: string;
  }) => <span data-testid={testId}>{children}</span>,
  PromptInputAttachment: () => <div />,
  PromptInputAttachments: () => <div />,
  PromptInputBody: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputButton: ({
    children,
    disabled,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled}>
      {children}
    </button>
  ),
  PromptInputFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputProvider: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputSpeechButton: () => <button type="button">Speech</button>,
  PromptInputSubmit: () => <button type="submit">Submit</button>,
  PromptInputTextarea: () => <textarea />,
  PromptInputTools: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="prompt-tools">{children}</div>
  ),
  usePromptInputController: () => ({
    textInput: { setInput: vi.fn() },
    attachments: { files: [] },
  }),
}));

vi.mock("@/components/chat/agent-tools-display", () => ({
  AgentToolsDisplay: () => <div data-testid="agent-tools-display" />,
}));

vi.mock("@/components/chat/chat-api-key-selector", () => ({
  ChatApiKeySelector: () => <div data-testid="chat-api-key-selector" />,
}));

vi.mock("@/components/chat/chat-tools-display", () => ({
  ChatToolsDisplay: () => <div data-testid="chat-tools-display" />,
}));

vi.mock("@/components/chat/knowledge-graph-upload-indicator", () => ({
  KnowledgeGraphUploadIndicator: () => (
    <div data-testid="knowledge-graph-indicator" />
  ),
}));

vi.mock("@/components/chat/model-selector", () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));

// Mock the Tooltip components to avoid Radix UI complexity
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content" role="tooltip">
      {children}
    </div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

// Mock the React Query hooks that the component uses
vi.mock("@/lib/agent-tools.query", () => ({
  useAgentDelegations: () => ({
    data: [],
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/lib/chat.query", () => ({
  useProfileToolsWithIds: () => ({
    data: [],
    isLoading: false,
    error: null,
  }),
}));

// Import the component after mocks are set up
import ArchestraPromptInput from "./prompt-input";

describe("ArchestraPromptInput", () => {
  const defaultProps = {
    onSubmit: vi.fn(),
    status: "ready" as const,
    selectedModel: "gpt-4",
    onModelChange: vi.fn(),
    agentId: "test-agent-id",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("File Upload Button", () => {
    it("should render enabled file upload button when allowFileUploads is true", () => {
      render(
        <ArchestraPromptInput {...defaultProps} allowFileUploads={true} />,
      );

      // Should find the enabled file upload button
      const enabledButton = screen.getByTestId(E2eTestId.ChatFileUploadButton);
      expect(enabledButton).toBeInTheDocument();

      // Should not find the disabled button
      expect(
        screen.queryByTestId(E2eTestId.ChatDisabledFileUploadButton),
      ).not.toBeInTheDocument();
    });

    it("should render disabled file upload button when allowFileUploads is false", () => {
      render(
        <ArchestraPromptInput {...defaultProps} allowFileUploads={false} />,
      );

      // Should find the disabled file upload button wrapper
      const disabledButton = screen.getByTestId(
        E2eTestId.ChatDisabledFileUploadButton,
      );
      expect(disabledButton).toBeInTheDocument();

      // Should not find the enabled button
      expect(
        screen.queryByTestId(E2eTestId.ChatFileUploadButton),
      ).not.toBeInTheDocument();
    });
  });

  describe("Component rendering", () => {
    it("should render the prompt input form", () => {
      render(
        <ArchestraPromptInput {...defaultProps} allowFileUploads={true} />,
      );

      expect(screen.getByTestId("prompt-input")).toBeInTheDocument();
    });

    it("should render model selector", () => {
      render(
        <ArchestraPromptInput {...defaultProps} allowFileUploads={true} />,
      );

      expect(screen.getByTestId("model-selector")).toBeInTheDocument();
    });

    it("should render 'Add tools & sub-agents' button when no tools or delegations exist", () => {
      render(
        <ArchestraPromptInput {...defaultProps} allowFileUploads={true} />,
      );

      // With empty tools and delegations from mocks, should show the "Add tools" button
      expect(screen.getByText("Add tools & sub-agents")).toBeInTheDocument();
      expect(
        screen.queryByTestId("chat-tools-display"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("agent-tools-display"),
      ).not.toBeInTheDocument();
    });
  });
});
