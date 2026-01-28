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
  usePromptInputAttachments: () => ({
    openFileDialog: vi.fn(),
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

// Mock for useHasPermissions - default to non-admin
const mockUseHasPermissions = vi.fn().mockReturnValue({
  data: false,
  isPending: false,
  isLoading: false,
});

vi.mock("@/lib/auth.query", () => ({
  useHasPermissions: () => mockUseHasPermissions(),
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
    it("should render enabled file upload button when allowFileUploads is true and model supports files", () => {
      render(
        <ArchestraPromptInput
          {...defaultProps}
          allowFileUploads={true}
          inputModalities={["text", "image"]}
        />,
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
        <ArchestraPromptInput
          {...defaultProps}
          allowFileUploads={false}
          inputModalities={["text", "image"]}
        />,
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

    it("should render disabled file upload button when model does not support files", () => {
      render(
        <ArchestraPromptInput
          {...defaultProps}
          allowFileUploads={true}
          inputModalities={["text"]}
        />,
      );

      // Should find the disabled file upload button wrapper
      const disabledButton = screen.getByTestId(
        E2eTestId.ChatDisabledFileUploadButton,
      );
      expect(disabledButton).toBeInTheDocument();

      // Tooltip should show message about model not supporting files
      const tooltip = screen.getByTestId("tooltip-content");
      expect(tooltip).toHaveTextContent(
        "This model does not support file uploads",
      );
    });

    it("should show settings link in tooltip for admins when file uploads disabled", () => {
      // Mock admin user with organization update permission
      mockUseHasPermissions.mockReturnValue({
        data: true,
        isPending: false,
        isLoading: false,
      });

      render(
        <ArchestraPromptInput
          {...defaultProps}
          allowFileUploads={false}
          inputModalities={["text", "image"]}
        />,
      );

      // Tooltip should show "Enable in settings" link for admins
      const tooltip = screen.getByTestId("tooltip-content");
      expect(tooltip).toHaveTextContent("File uploads are disabled.");
      expect(tooltip).toHaveTextContent("Enable in settings");
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "/settings/security",
      );
      expect(screen.getByRole("link")).toHaveAttribute(
        "aria-label",
        "Enable file uploads in security settings",
      );
    });

    it("should show admin message in tooltip for non-admins when file uploads disabled", () => {
      // Mock non-admin user without organization update permission
      mockUseHasPermissions.mockReturnValue({
        data: false,
        isPending: false,
        isLoading: false,
      });

      render(
        <ArchestraPromptInput
          {...defaultProps}
          allowFileUploads={false}
          inputModalities={["text", "image"]}
        />,
      );

      // Tooltip should show message about admin for non-admins
      const tooltip = screen.getByTestId("tooltip-content");
      expect(tooltip).toHaveTextContent(
        "File uploads are disabled by your administrator",
      );
      // Should not have a settings link
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
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
