import { type ChatSkillMetadata, E2eTestId } from "@archestra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatMessageQueue } from "@/lib/chat/chat-message-queue";
import { NEW_CHAT_DRAFT_STORAGE_KEY } from "@/lib/chat/chat-utils";

const {
  mockUseChatPlaceholder,
  mockUseSkillsPaginated,
  mockTextInputSetInput,
  mockTextInputClear,
  mockControllerState,
  mockFeatureState,
  mockProfileState,
} = vi.hoisted(() => ({
  mockUseChatPlaceholder: vi.fn(),
  mockUseSkillsPaginated: vi.fn(),
  mockTextInputSetInput: vi.fn(),
  mockTextInputClear: vi.fn(),
  mockControllerState: { value: "", files: [] as { url: string }[] },
  mockFeatureState: { chatSecretScanEnabled: false, betaEnabled: false },
  mockProfileState: {
    agent: null as { sandboxAvailable: boolean } | null,
  },
}));

// Mock ResizeObserver (used by Radix UI components and the prompt input's
// toolbar-collapse hook). Must be a real constructor so `new ResizeObserver()`
// works. jsdom reports 0 widths, so the hook measures nothing and leaves the
// toolbar in its full (expanded) layout — which is what these tests exercise.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock window.matchMedia for useIsMobile hook
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock all the complex dependencies
vi.mock("@/components/ai-elements/prompt-input", () => ({
  PromptInput: ({
    children,
    onSubmit,
  }: {
    children: React.ReactNode;
    onSubmit?: (
      message: { text: string; files: typeof mockControllerState.files },
      event: React.FormEvent<HTMLFormElement>,
    ) => void | Promise<void>;
  }) => (
    <form
      data-testid="prompt-input"
      onSubmit={(event) => {
        event.preventDefault();
        // Mirror ai-elements: a sync throw / rejected promise is swallowed
        // here (the textarea is not cleared on rejection).
        try {
          const result = onSubmit?.(
            {
              text: mockControllerState.value,
              files: mockControllerState.files,
            },
            event,
          );
          if (result instanceof Promise) {
            result.catch(() => {});
          }
        } catch {
          // rejected submit — keep the input
        }
      }}
    >
      {children}
    </form>
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
  PromptInputCommand: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="prompt-command">{children}</div>
  ),
  PromptInputCommandEmpty: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputCommandGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputCommandItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
  PromptInputCommandList: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
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
  PromptInputSubmit: ({ status }: { status?: string }) => (
    <button data-testid="prompt-submit" type="submit">
      Submit {status ?? "unset"}
    </button>
  ),
  PromptInputTextarea: ({
    placeholder,
    onKeyDown,
    disabled,
    "data-testid": testId,
  }: {
    placeholder?: string;
    onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <textarea
      data-testid={testId}
      disabled={disabled}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
    />
  ),
  PromptInputTools: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="prompt-tools">{children}</div>
  ),
  usePromptInputController: () => ({
    textInput: {
      value: mockControllerState.value,
      setInput: mockTextInputSetInput,
      clear: mockTextInputClear,
    },
    attachments: { files: [] },
  }),
  usePromptInputAttachments: () => ({
    openFileDialog: vi.fn(),
  }),
}));

vi.mock("@/components/chat/agent-tools-display", () => ({
  AgentToolsDisplay: () => <div data-testid="agent-tools-display" />,
}));

vi.mock("@/components/chat/llm-provider-api-key-selector", () => ({
  LlmProviderApiKeySelector: () => <div data-testid="chat-api-key-selector" />,
}));

vi.mock("@/components/chat/chat-tools-display", () => ({
  ChatToolsDisplay: () => <div data-testid="chat-tools-display" />,
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

// Mock agent query hooks; mockProfileState.agent controls sandboxAvailable
vi.mock("@/lib/agent.query", () => ({
  useProfile: () => ({
    data: mockProfileState.agent,
    isLoading: false,
    error: null,
  }),
}));

// Mock the React Query hooks that the component uses
vi.mock("@/lib/agent-tools.query", () => ({
  useAgentDelegations: () => ({
    data: [],
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/lib/chat/chat.query", () => ({
  useProfileToolsWithIds: () => ({
    data: [],
    isLoading: false,
    error: null,
  }),
  useConversation: () => ({ data: null }),
  useToggleHooksDebug: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/lib/organization.query");

vi.mock("@/lib/chat/chat-placeholder.hook", () => ({
  useChatPlaceholder: (...args: unknown[]) => mockUseChatPlaceholder(...args),
}));

vi.mock("@/lib/skills/skill.query", () => ({
  useSkillsPaginated: () => mockUseSkillsPaginated(),
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/config/config.query");

// Import the component after mocks are set up
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useOrganization } from "@/lib/organization.query";
import ArchestraPromptInput from "./prompt-input";

describe("ArchestraPromptInput", () => {
  const defaultProps = {
    onSubmit: vi.fn(),
    status: "ready" as const,
    selectedModel: "gpt-4",
    onModelChange: vi.fn(),
    agentId: "test-agent-id",
    isPlaywrightSetupVisible: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useOrganization).mockReturnValue({
      data: null,
      isLoading: false,
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
      isLoading: false,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useFeature).mockImplementation((flag) => {
      if (flag === "chatSecretScanEnabled") {
        return mockFeatureState.chatSecretScanEnabled;
      }
      if (flag === "betaEnabled") {
        return mockFeatureState.betaEnabled;
      }
      return undefined;
    });
    mockUseChatPlaceholder.mockReturnValue({
      placeholder: "Animated placeholder",
      isAnimating: true,
    });
    mockUseSkillsPaginated.mockReturnValue({
      data: undefined,
      isLoading: false,
    });
    mockControllerState.value = "";
    mockControllerState.files = [];
    mockFeatureState.chatSecretScanEnabled = false;
    mockFeatureState.betaEnabled = false;
    mockProfileState.agent = null;
    localStorage.clear();
  });

  describe("File Upload Button", () => {
    // The composer renders more than one tooltip now (the submit button carries
    // a keyboard-shortcut tooltip too), so scope file-upload assertions to the
    // tooltip whose content matches.
    const getFileUploadTooltip = (text: string): HTMLElement => {
      const tooltip = screen
        .getAllByTestId("tooltip-content")
        .find((element) => element.textContent?.includes(text));
      if (!tooltip) {
        throw new Error(`No tooltip content matching "${text}"`);
      }
      return tooltip;
    };

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
          inputModalities={null}
        />,
      );

      // Should find the disabled file upload button wrapper
      const disabledButton = screen.getByTestId(
        E2eTestId.ChatDisabledFileUploadButton,
      );
      expect(disabledButton).toBeInTheDocument();

      // Tooltip should show message about model not supporting files
      const tooltip = getFileUploadTooltip("does not support file uploads");
      expect(tooltip).toHaveTextContent(
        "This model does not support file uploads",
      );
    });

    it("should render enabled file upload button for text-only models", () => {
      render(
        <ArchestraPromptInput
          {...defaultProps}
          allowFileUploads={true}
          inputModalities={["text"]}
        />,
      );

      expect(
        screen.getByTestId(E2eTestId.ChatFileUploadButton),
      ).toBeInTheDocument();
      // Enabled state shows the supported-types tooltip rather than the
      // disabled "does not support file uploads" message.
      expect(getFileUploadTooltip("Supports:")).toHaveTextContent("Supports:");
    });

    it("should show settings link in tooltip for admins when file uploads disabled", () => {
      // Mock admin user with agentSettings update permission
      vi.mocked(useHasPermissions).mockReturnValue({
        data: true,
        isPending: false,
        isLoading: false,
      } as ReturnType<typeof useHasPermissions>);

      render(
        <ArchestraPromptInput
          {...defaultProps}
          allowFileUploads={false}
          inputModalities={["text", "image"]}
        />,
      );

      // Tooltip should show "Enable in settings" link for admins
      const tooltip = getFileUploadTooltip("File uploads are disabled");
      expect(tooltip).toHaveTextContent("File uploads are disabled.");
      expect(tooltip).toHaveTextContent("Enable in settings");
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "/settings/agents",
      );
      expect(screen.getByRole("link")).toHaveAttribute(
        "aria-label",
        "Enable file uploads in agent settings",
      );
    });

    it("should show admin message in tooltip for non-admins when file uploads disabled", () => {
      // Mock non-admin user without agentSettings update permission
      vi.mocked(useHasPermissions).mockReturnValue({
        data: false,
        isPending: false,
        isLoading: false,
      } as ReturnType<typeof useHasPermissions>);

      render(
        <ArchestraPromptInput
          {...defaultProps}
          allowFileUploads={false}
          inputModalities={["text", "image"]}
        />,
      );

      // Tooltip should show message about admin for non-admins
      const tooltip = getFileUploadTooltip(
        "File uploads are disabled by your administrator",
      );
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

    it("should show the submit state as ready after an error", () => {
      render(
        <ArchestraPromptInput
          {...defaultProps}
          status="error"
          allowFileUploads={true}
        />,
      );

      expect(screen.getByTestId("prompt-submit")).toHaveTextContent(
        "Submit ready",
      );
    });

    it("should render model selector when user has provider settings permission", () => {
      vi.mocked(useHasPermissions).mockReturnValue({
        data: true,
        isPending: false,
        isLoading: false,
      } as ReturnType<typeof useHasPermissions>);

      render(
        <ArchestraPromptInput {...defaultProps} allowFileUploads={true} />,
      );

      expect(screen.getByTestId("model-selector")).toBeInTheDocument();
    });

    it("should keep a single organization placeholder static", () => {
      vi.mocked(useOrganization).mockReturnValue({
        data: {
          chatPlaceholders: ["Ask the support agent"],
          animateChatPlaceholders: true,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useOrganization>);
      mockUseChatPlaceholder.mockReturnValue({
        placeholder: "Ask the support agent",
        isAnimating: false,
      });

      render(
        <ArchestraPromptInput {...defaultProps} allowFileUploads={true} />,
      );

      expect(mockUseChatPlaceholder).toHaveBeenCalledWith({
        animate: true,
        placeholders: ["Ask the support agent"],
      });
      expect(
        screen.getByPlaceholderText("Ask the support agent"),
      ).toBeInTheDocument();
      expect(
        screen.queryByPlaceholderText("Animated placeholder"),
      ).not.toBeInTheDocument();
    });

    it("should keep placeholders static when animation is disabled", () => {
      vi.mocked(useOrganization).mockReturnValue({
        data: {
          chatPlaceholders: ["First placeholder", "Second placeholder"],
          animateChatPlaceholders: false,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useOrganization>);
      mockUseChatPlaceholder.mockReturnValue({
        placeholder: "Second placeholder",
        isAnimating: false,
      });

      render(
        <ArchestraPromptInput {...defaultProps} allowFileUploads={true} />,
      );

      expect(mockUseChatPlaceholder).toHaveBeenCalledWith({
        animate: false,
        placeholders: ["First placeholder", "Second placeholder"],
      });
      expect(
        screen.getByPlaceholderText("Second placeholder"),
      ).toBeInTheDocument();
      expect(
        screen.queryByPlaceholderText("Animated placeholder"),
      ).not.toBeInTheDocument();
    });

    it("should reset slash command selection when the menu reopens", () => {
      const onCompactConversation = vi.fn();
      mockControllerState.value = "/";

      const { rerender } = render(
        <ArchestraPromptInput
          {...defaultProps}
          conversationId="conversation-1"
          onCompactConversation={onCompactConversation}
        />,
      );

      fireEvent.keyDown(screen.getByTestId(E2eTestId.ChatPromptTextarea), {
        key: "ArrowDown",
      });

      mockControllerState.value = "";
      rerender(
        <ArchestraPromptInput
          {...defaultProps}
          conversationId="conversation-1"
          onCompactConversation={onCompactConversation}
        />,
      );

      mockControllerState.value = "/";
      rerender(
        <ArchestraPromptInput
          {...defaultProps}
          conversationId="conversation-1"
          onCompactConversation={onCompactConversation}
        />,
      );

      fireEvent.keyDown(screen.getByTestId(E2eTestId.ChatPromptTextarea), {
        key: "Enter",
      });

      expect(onCompactConversation).toHaveBeenCalledTimes(1);
      expect(mockTextInputClear).toHaveBeenCalled();
    });
  });

  describe("sensitive data detection", () => {
    const fakeGithubToken = `ghp_${"a".repeat(36)}`;

    it("flag off: plain submit works", () => {
      const onSubmit = vi.fn();
      mockFeatureState.chatSecretScanEnabled = false;
      mockControllerState.value = "just a normal message";

      render(<ArchestraPromptInput {...defaultProps} onSubmit={onSubmit} />);
      fireEvent.submit(screen.getByTestId("prompt-input"));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByText(
          "Your message seems to contain sensitive data, are you sure?",
        ),
      ).not.toBeInTheDocument();
    });

    it("flag off: token-like content submits with no dialog", () => {
      const onSubmit = vi.fn();
      mockFeatureState.chatSecretScanEnabled = false;
      mockControllerState.value = `please rotate ${fakeGithubToken}`;

      render(<ArchestraPromptInput {...defaultProps} onSubmit={onSubmit} />);
      fireEvent.submit(screen.getByTestId("prompt-input"));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByText(
          "Your message seems to contain sensitive data, are you sure?",
        ),
      ).not.toBeInTheDocument();
    });

    it("flag on: plain message submits as before", () => {
      const onSubmit = vi.fn();
      mockFeatureState.chatSecretScanEnabled = true;
      mockControllerState.value = "just a normal message";

      render(<ArchestraPromptInput {...defaultProps} onSubmit={onSubmit} />);
      fireEvent.submit(screen.getByTestId("prompt-input"));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByText(
          "Your message seems to contain sensitive data, are you sure?",
        ),
      ).not.toBeInTheDocument();
    });

    it("flag on: detected token opens the dialog and suppresses onSubmit", () => {
      const onSubmit = vi.fn();
      mockFeatureState.chatSecretScanEnabled = true;
      mockControllerState.value = `please rotate ${fakeGithubToken}`;

      render(<ArchestraPromptInput {...defaultProps} onSubmit={onSubmit} />);
      fireEvent.submit(screen.getByTestId("prompt-input"));

      expect(onSubmit).not.toHaveBeenCalled();
      expect(
        screen.getByText(
          "Your message seems to contain sensitive data, are you sure?",
        ),
      ).toBeInTheDocument();
    });

    it("flag on: clicking Send anyway dispatches onSubmit with the original message", () => {
      const onSubmit = vi.fn();
      mockFeatureState.chatSecretScanEnabled = true;
      const text = `please rotate ${fakeGithubToken}`;
      mockControllerState.value = text;

      render(<ArchestraPromptInput {...defaultProps} onSubmit={onSubmit} />);
      fireEvent.submit(screen.getByTestId("prompt-input"));

      fireEvent.click(screen.getByRole("button", { name: "Send anyway" }));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      const [message] = onSubmit.mock.calls[0];
      expect(message.text).toBe(text);
    });

    it("flag on: Send anyway with a throwing consumer keeps the draft and does not hang", () => {
      mockFeatureState.chatSecretScanEnabled = true;
      const agentId = "agent-1";
      // The new-chat draft key is agent-independent (so a typed prompt survives
      // an agent switch); the agentId prop below no longer affects the key.
      const draftKey = NEW_CHAT_DRAFT_STORAGE_KEY;
      const text = `please rotate ${fakeGithubToken}`;
      localStorage.setItem(draftKey, text);
      mockControllerState.value = text;

      // Mirrors a consumer rejecting a submit by throwing synchronously after
      // the user confirms "Send anyway" (e.g. the main composer's
      // "stop-not-submit" throw that keeps a half-typed follow-up).
      const onSubmit = vi.fn(() => {
        throw new Error("rejected");
      });

      render(
        <ArchestraPromptInput
          {...defaultProps}
          agentId={agentId}
          onSubmit={onSubmit}
        />,
      );
      fireEvent.submit(screen.getByTestId("prompt-input"));

      // Confirm the dialog; the throw must be caught and routed to the pending
      // promise's reject (which the form swallows), not falsely resolved.
      fireEvent.click(screen.getByRole("button", { name: "Send anyway" }));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      // The throwing consumer refused the submit: the draft survives and the
      // dialog closes (composer is not stuck) instead of being cleared.
      expect(localStorage.getItem(draftKey)).toBe(text);
      expect(mockTextInputClear).not.toHaveBeenCalled();
      expect(
        screen.queryByText(
          "Your message seems to contain sensitive data, are you sure?",
        ),
      ).not.toBeInTheDocument();
    });

    it("flag on: Send anyway with an async-rejecting consumer keeps the draft and does not hang", async () => {
      mockFeatureState.chatSecretScanEnabled = true;
      const agentId = "agent-1";
      // The new-chat draft key is agent-independent (so a typed prompt survives
      // an agent switch); the agentId prop below no longer affects the key.
      const draftKey = NEW_CHAT_DRAFT_STORAGE_KEY;
      const text = `please rotate ${fakeGithubToken}`;
      localStorage.setItem(draftKey, text);
      mockControllerState.value = text;

      const onSubmit = vi.fn(() => Promise.reject(new Error("rejected")));

      render(
        <ArchestraPromptInput
          {...defaultProps}
          agentId={agentId}
          onSubmit={onSubmit}
        />,
      );
      fireEvent.submit(screen.getByTestId("prompt-input"));

      fireEvent.click(screen.getByRole("button", { name: "Send anyway" }));

      // Let the rejected dispatch settle; it must route to reject (no draft
      // clear) and be swallowed by the form (no unhandled rejection).
      await Promise.resolve();
      await Promise.resolve();

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(draftKey)).toBe(text);
      expect(mockTextInputClear).not.toHaveBeenCalled();
      expect(
        screen.queryByText(
          "Your message seems to contain sensitive data, are you sure?",
        ),
      ).not.toBeInTheDocument();
    });

    it("flag on: clicking Cancel does not call onSubmit", () => {
      const onSubmit = vi.fn();
      mockFeatureState.chatSecretScanEnabled = true;
      mockControllerState.value = `please rotate ${fakeGithubToken}`;

      render(<ArchestraPromptInput {...defaultProps} onSubmit={onSubmit} />);
      fireEvent.submit(screen.getByTestId("prompt-input"));

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onSubmit).not.toHaveBeenCalled();
      expect(
        screen.queryByText(
          "Your message seems to contain sensitive data, are you sure?",
        ),
      ).not.toBeInTheDocument();
    });
  });

  describe("skill slash commands", () => {
    const skill = {
      id: "skill-1",
      name: "My Skill",
      description: "Does things",
    };

    beforeEach(() => {
      vi.mocked(useOrganization).mockReturnValue({
        data: { skillToolsEnabled: true },
        isLoading: false,
      } as unknown as ReturnType<typeof useOrganization>);
      mockUseSkillsPaginated.mockReturnValue({
        data: { data: [skill] },
        isLoading: false,
      });
    });

    it("submits a bare skill command with skill metadata and an empty prompt", () => {
      const onSubmit = vi.fn();
      mockControllerState.value = "/my-skill";

      render(<ArchestraPromptInput {...defaultProps} onSubmit={onSubmit} />);
      fireEvent.submit(screen.getByTestId("prompt-input"));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      const [message, , options] = onSubmit.mock.calls[0];
      expect(message.text).toBe("");
      expect(options).toEqual({ skill: { id: skill.id, name: skill.name } });
    });

    it("submits a skill command with the text after the token as the prompt", () => {
      const onSubmit = vi.fn();
      mockControllerState.value = "/my-skill summarize the repo";

      render(<ArchestraPromptInput {...defaultProps} onSubmit={onSubmit} />);
      fireEvent.submit(screen.getByTestId("prompt-input"));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      const [message, , options] = onSubmit.mock.calls[0];
      expect(message.text).toBe("summarize the repo");
      expect(options).toEqual({ skill: { id: skill.id, name: skill.name } });
    });

    it("keeps skill command handling with the sandbox available", () => {
      const onSubmit = vi.fn();
      mockProfileState.agent = { sandboxAvailable: true };
      mockControllerState.value = "/my-skill summarize the repo";

      render(<ArchestraPromptInput {...defaultProps} onSubmit={onSubmit} />);
      fireEvent.submit(screen.getByTestId("prompt-input"));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      const [message, , options] = onSubmit.mock.calls[0];
      expect(message.text).toBe("summarize the repo");
      expect(options).toEqual({ skill: { id: skill.id, name: skill.name } });
    });
  });

  describe("sandbox commands", () => {
    it("sandbox available: a `!` message dispatches with the sandboxCommand option and unchanged text", () => {
      const onSubmit = vi.fn();
      mockProfileState.agent = { sandboxAvailable: true };
      mockControllerState.value = "! echo hi";

      render(<ArchestraPromptInput {...defaultProps} onSubmit={onSubmit} />);
      fireEvent.submit(screen.getByTestId("prompt-input"));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      const [message, , options] = onSubmit.mock.calls[0];
      expect(message.text).toBe("! echo hi");
      expect(options).toEqual({ sandboxCommand: true });
    });

    it("sandbox unavailable: the same `!` message submits as a plain message", () => {
      const onSubmit = vi.fn();
      mockProfileState.agent = { sandboxAvailable: false };
      mockControllerState.value = "! echo hi";

      render(<ArchestraPromptInput {...defaultProps} onSubmit={onSubmit} />);
      fireEvent.submit(screen.getByTestId("prompt-input"));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      const [message, , options] = onSubmit.mock.calls[0];
      expect(message.text).toBe("! echo hi");
      expect(options).toBeUndefined();
    });

    it("a bare `!` submits as a plain message even with the sandbox available", () => {
      const onSubmit = vi.fn();
      mockProfileState.agent = { sandboxAvailable: true };
      mockControllerState.value = "!";

      render(<ArchestraPromptInput {...defaultProps} onSubmit={onSubmit} />);
      fireEvent.submit(screen.getByTestId("prompt-input"));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      const [message, , options] = onSubmit.mock.calls[0];
      expect(message.text).toBe("!");
      expect(options).toBeUndefined();
    });

    it("keeps /compact interception with the sandbox available", () => {
      const onSubmit = vi.fn();
      const onCompactConversation = vi.fn();
      mockProfileState.agent = { sandboxAvailable: true };
      mockControllerState.value = "/compact";

      render(
        <ArchestraPromptInput
          {...defaultProps}
          conversationId="conversation-1"
          onCompactConversation={onCompactConversation}
          onSubmit={onSubmit}
        />,
      );
      fireEvent.submit(screen.getByTestId("prompt-input"));

      expect(onCompactConversation).toHaveBeenCalledTimes(1);
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe("draft retention on submit", () => {
    const agentId = "agent-1";
    // The new-chat draft key is agent-independent (so a typed prompt survives
    // an agent switch); the agentId prop below no longer affects the key.
    const draftKey = NEW_CHAT_DRAFT_STORAGE_KEY;

    it("keeps the saved draft when the consumer rejects the submit", () => {
      const text = "draft text the user typed";
      localStorage.setItem(draftKey, text);
      mockControllerState.value = text;
      // A consumer that refuses the submit (e.g. text + unsupported attachment)
      // by throwing — the draft (and the typed text) must survive.
      const onSubmit = vi.fn(() => {
        throw new Error("rejected");
      });

      render(
        <ArchestraPromptInput
          {...defaultProps}
          agentId={agentId}
          onSubmit={onSubmit}
        />,
      );
      fireEvent.submit(screen.getByTestId("prompt-input"));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(draftKey)).toBe(text);
      // ai-elements only clears the textarea on a non-throwing return.
      expect(mockTextInputClear).not.toHaveBeenCalled();
    });

    it("clears the saved draft exactly once on an accepted submit", () => {
      const text = "a normal accepted message";
      localStorage.setItem(draftKey, text);
      mockControllerState.value = text;
      const onSubmit = vi.fn();

      render(
        <ArchestraPromptInput
          {...defaultProps}
          agentId={agentId}
          onSubmit={onSubmit}
        />,
      );
      fireEvent.submit(screen.getByTestId("prompt-input"));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(draftKey)).toBeNull();
    });
  });

  describe("queue keyboard shortcuts", () => {
    it("pops the most recently queued message into the composer on ArrowUp when empty", () => {
      mockFeatureState.betaEnabled = true;
      const conversationId = "conv-arrowup-pop";
      chatMessageQueue.clear(conversationId);
      chatMessageQueue.enqueue(conversationId, { text: "first queued" });
      chatMessageQueue.enqueue(conversationId, { text: "second queued" });
      mockControllerState.value = "";

      render(
        <ArchestraPromptInput
          {...defaultProps}
          conversationId={conversationId}
        />,
      );

      fireEvent.keyDown(screen.getByTestId(E2eTestId.ChatPromptTextarea), {
        key: "ArrowUp",
      });

      // The newest queued message loads into the composer...
      expect(mockTextInputSetInput).toHaveBeenCalledWith("second queued");
      // ...and is removed from the queue, leaving the older one behind.
      expect(chatMessageQueue.get(conversationId).map((m) => m.text)).toEqual([
        "first queued",
      ]);

      chatMessageQueue.clear(conversationId);
    });

    it("prefixes a queued skill command when popping it back", () => {
      mockFeatureState.betaEnabled = true;
      const conversationId = "conv-arrowup-skill";
      chatMessageQueue.clear(conversationId);
      chatMessageQueue.enqueue(conversationId, {
        text: "do the thing",
        skill: { name: "helper" } as ChatSkillMetadata,
      });
      mockControllerState.value = "";

      render(
        <ArchestraPromptInput
          {...defaultProps}
          conversationId={conversationId}
        />,
      );

      fireEvent.keyDown(screen.getByTestId(E2eTestId.ChatPromptTextarea), {
        key: "ArrowUp",
      });

      expect(mockTextInputSetInput).toHaveBeenCalledWith(
        "/helper do the thing",
      );
      chatMessageQueue.clear(conversationId);
    });

    it("leaves the queue alone on ArrowUp when the composer already has text", () => {
      mockFeatureState.betaEnabled = true;
      const conversationId = "conv-arrowup-nonempty";
      chatMessageQueue.clear(conversationId);
      chatMessageQueue.enqueue(conversationId, { text: "queued" });
      mockControllerState.value = "typing";

      render(
        <ArchestraPromptInput
          {...defaultProps}
          conversationId={conversationId}
        />,
      );

      fireEvent.keyDown(screen.getByTestId(E2eTestId.ChatPromptTextarea), {
        key: "ArrowUp",
      });

      // ArrowUp is ignored while typing: the queue is untouched and the typed
      // text is never replaced by a queued message.
      expect(mockTextInputSetInput).not.toHaveBeenCalledWith("queued");
      expect(chatMessageQueue.get(conversationId)).toHaveLength(1);
      chatMessageQueue.clear(conversationId);
    });

    it("stops the in-flight response on Escape", () => {
      const onStop = vi.fn();

      render(
        <ArchestraPromptInput
          {...defaultProps}
          status="streaming"
          onStop={onStop}
          conversationId="conv-escape-stop"
        />,
      );

      fireEvent.keyDown(screen.getByTestId(E2eTestId.ChatPromptTextarea), {
        key: "Escape",
      });

      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("does not stop on Escape when no response is in flight", () => {
      const onStop = vi.fn();

      render(
        <ArchestraPromptInput
          {...defaultProps}
          status="ready"
          onStop={onStop}
          conversationId="conv-escape-idle"
        />,
      );

      fireEvent.keyDown(screen.getByTestId(E2eTestId.ChatPromptTextarea), {
        key: "Escape",
      });

      expect(onStop).not.toHaveBeenCalled();
    });
  });
});
