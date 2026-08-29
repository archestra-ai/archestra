import { type ChatSkillMetadata, E2eTestId } from "@archestra/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCKED_CHAT_DRAFT_SHORTCUT_EVENT } from "@/consts";
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
  mockUploadPolicy,
  mockToolbarState,
  mockConversationState,
} = vi.hoisted(() => ({
  mockUseChatPlaceholder: vi.fn(),
  mockUseSkillsPaginated: vi.fn(),
  mockTextInputSetInput: vi.fn(),
  mockTextInputClear: vi.fn(),
  mockControllerState: { value: "", files: [] as { url: string }[] },
  mockFeatureState: {
    chatSecretScanEnabled: false,
    lockedChatEnabled: false,
    chatAttachmentStorageBytesLimit: undefined as number | undefined,
    apiBodyLimitBytes: undefined as number | undefined,
    sandboxArtifactBytesLimit: undefined as number | undefined,
  },
  mockProfileState: {
    agent: null as { sandboxAvailable: boolean } | null,
  },
  // What useConversation resolves to — lets tests exercise an existing
  // locked chat (vs the new-chat toggle).
  mockConversationState: {
    conversation: null as { lockedChat?: boolean } | null,
  },
  // The upload policy the composer hands to the file picker: the byte cap it
  // enforces and the per-file check it runs. Captured so tests can exercise
  // the real policy the way the picker does.
  mockUploadPolicy: {
    maxFileSize: undefined as number | undefined,
    validateFile: undefined as ((file: File) => string | null) | undefined,
  },
  // Drives the toolbar's collapsed (narrow) layout, which jsdom's 0-width
  // measurements would otherwise never trigger.
  mockToolbarState: { isNarrow: false },
}));

vi.mock("@/lib/hooks/use-toolbar-collapse", () => ({
  useToolbarCollapse: () => mockToolbarState.isNarrow,
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

vi.mock("sonner", () => {
  const toast = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() });
  return { toast, Toaster: () => null };
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
  PromptInputProvider: ({
    children,
    maxFileSize,
    validateFile,
  }: {
    children: React.ReactNode;
    maxFileSize?: number;
    validateFile?: (file: File) => string | null;
  }) => {
    mockUploadPolicy.maxFileSize = maxFileSize;
    mockUploadPolicy.validateFile = validateFile;
    return <div>{children}</div>;
  },
  PromptInputSpeechButton: () => <button type="button">Speech</button>,
  PromptInputSubmit: ({
    status,
    disabled,
    onClick,
  }: {
    status?: string;
    disabled?: boolean;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
  }) => (
    <button
      data-testid="prompt-submit"
      type="submit"
      disabled={disabled}
      onClick={onClick}
    >
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
    attachments: { files: mockControllerState.files },
  }),
  usePromptInputAttachments: () => ({
    openFileDialog: vi.fn(),
    clear: vi.fn(),
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

// The Apps Hackathon recorder cluster is a self-contained feature with its own
// tests; stub it here so the composer test needs no QueryClient/config context.
vi.mock("@/components/app-session-recording/app-recording-controls", () => ({
  AppRecordingControls: () => null,
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
  useConversation: () => ({ data: mockConversationState.conversation }),
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

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: () => ({ data: [] }),
}));

// Import the component after mocks are set up
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import ArchestraPromptInput from "./prompt-input";

describe("ArchestraPromptInput", () => {
  const defaultProps = {
    onSubmit: vi.fn(),
    status: "ready" as const,
    selectedModel: "gpt-4",
    onModelChange: vi.fn(),
    agentId: "test-agent-id",
    isPlaywrightSetupRequired: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useOrganization).mockReturnValue({
      data: null,
      isLoading: false,
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useAppearanceSettings).mockReturnValue({
      data: undefined,
      isLoading: false,
    } as unknown as ReturnType<typeof useAppearanceSettings>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
      isPending: false,
      isLoading: false,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useFeature).mockImplementation((flag) => {
      if (flag === "chatSecretScanEnabled") {
        return mockFeatureState.chatSecretScanEnabled;
      }
      if (flag === "lockedChatEnabled") {
        return mockFeatureState.lockedChatEnabled;
      }
      if (flag === "chatAttachmentStorageBytesLimit") {
        return mockFeatureState.chatAttachmentStorageBytesLimit;
      }
      if (flag === "apiBodyLimitBytes") {
        return mockFeatureState.apiBodyLimitBytes;
      }
      if (flag === "sandboxArtifactBytesLimit") {
        return mockFeatureState.sandboxArtifactBytesLimit;
      }
      return undefined;
    });
    mockFeatureState.chatAttachmentStorageBytesLimit = undefined;
    mockFeatureState.apiBodyLimitBytes = undefined;
    mockFeatureState.sandboxArtifactBytesLimit = undefined;
    mockUploadPolicy.maxFileSize = undefined;
    mockUploadPolicy.validateFile = undefined;
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
    mockFeatureState.lockedChatEnabled = false;
    mockProfileState.agent = null;
    mockToolbarState.isNarrow = false;
    mockConversationState.conversation = null;
    localStorage.clear();
  });

  it("turns the composer into a focused execution launcher", () => {
    render(
      <ArchestraPromptInput
        {...defaultProps}
        executionMode
        executionAgentName="Codex"
        allowFileUploads
      />,
    );

    expect(
      screen.getByText(
        "Starts Codex in an isolated execution. This becomes its live terminal when ready.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId(E2eTestId.ChatPromptTextarea)).toHaveAttribute(
      "placeholder",
      "Describe the task to run...",
    );
    expect(
      screen.getByTestId(E2eTestId.ChatFileUploadButton),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(E2eTestId.ChatDisabledFileUploadButton),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("model-selector")).not.toBeInTheDocument();
    expect(screen.queryByText("Speech")).not.toBeInTheDocument();
  });

  it("shows subscription sign-in without provider settings permission", () => {
    const onSubmit = vi.fn();
    mockControllerState.value = "keep this draft";

    render(
      <ArchestraPromptInput
        {...defaultProps}
        onSubmit={onSubmit}
        subscriptionConnectRequired
        subscriptionProvider="openai"
        modelSource="agent"
      />,
    );

    expect(screen.getByTestId("prompt-submit")).toBeDisabled();
    expect(screen.queryByTestId("model-selector")).not.toBeInTheDocument();
    expect(screen.queryByText("agent")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with ChatGPT" }),
    );
    fireEvent.submit(screen.getByTestId("prompt-input"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(mockTextInputClear).not.toHaveBeenCalled();
  });

  it("uses the subscription registry's SuperGrok sign-in label", () => {
    render(
      <ArchestraPromptInput
        {...defaultProps}
        subscriptionConnectRequired
        subscriptionProvider="xai"
        modelSource="agent"
      />,
    );

    expect(
      screen.getByRole("button", { name: "Sign in with Grok" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sign in with xAI" }),
    ).not.toBeInTheDocument();
  });

  describe("Limited-for-complex-tasks badge", () => {
    const badgeName = /limited for complex tasks/i;

    it("stays visible in the collapsed toolbar for an agent-inherited model", () => {
      // The collapsed toolbar's logo-shortcut branch (agent-sourced model with
      // a provider logo) once rendered only the logo, dropping the warning
      // that the wide toolbar showed.
      mockToolbarState.isNarrow = true;
      render(
        <ArchestraPromptInput
          {...defaultProps}
          notRecommendedForAgents
          modelSource="agent"
          currentProvider="ollama"
        />,
      );

      expect(
        screen.getByRole("button", { name: badgeName }),
      ).toBeInTheDocument();
    });

    it("stays visible in the collapsed toolbar without provider-settings permission", () => {
      // beforeEach denies every permission — the restricted user must still
      // see the warning, not just users who can open provider settings.
      mockToolbarState.isNarrow = true;
      render(
        <ArchestraPromptInput {...defaultProps} notRecommendedForAgents />,
      );

      expect(
        screen.getByRole("button", { name: badgeName }),
      ).toBeInTheDocument();
    });

    it("renders in the wide toolbar", () => {
      render(
        <ArchestraPromptInput {...defaultProps} notRecommendedForAgents />,
      );

      expect(
        screen.getByRole("button", { name: badgeName }),
      ).toBeInTheDocument();
    });

    it("renders nothing when the model is not flagged", () => {
      mockToolbarState.isNarrow = true;
      render(<ArchestraPromptInput {...defaultProps} />);

      expect(
        screen.queryByRole("button", { name: badgeName }),
      ).not.toBeInTheDocument();
    });
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

    it("should render enabled file upload button even when the model has no file modalities", () => {
      // A file the model can't read still lands in the conversation's Files
      // panel, so uploads stay offered regardless of modalities or sandbox.
      render(
        <ArchestraPromptInput
          {...defaultProps}
          allowFileUploads={true}
          inputModalities={null}
        />,
      );

      expect(
        screen.getByTestId(E2eTestId.ChatFileUploadButton),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId(E2eTestId.ChatDisabledFileUploadButton),
      ).not.toBeInTheDocument();
    });

    describe("attachment size policy", () => {
      // The policy reads `file.size`, never the bytes, so declare the size
      // rather than allocating tens of megabytes per case.
      const sized = (bytes: number, name = "archive.zip"): File => {
        const file = new File([], name, { type: "application/zip" });
        Object.defineProperty(file, "size", { value: bytes });
        return file;
      };

      const renderComposer = () =>
        render(
          <ArchestraPromptInput
            {...defaultProps}
            allowFileUploads={true}
            inputModalities={["text", "image"]}
          />,
        );

      it("caps the picker at the server's storage limit", () => {
        mockFeatureState.chatAttachmentStorageBytesLimit = 8 * 1024 * 1024;
        renderComposer();

        expect(mockUploadPolicy.maxFileSize).toBe(8 * 1024 * 1024);
      });

      it("rejects a file over the storage limit, naming that limit", () => {
        mockFeatureState.chatAttachmentStorageBytesLimit = 8 * 1024 * 1024;
        renderComposer();

        expect(
          mockUploadPolicy.validateFile?.(sized(8 * 1024 * 1024 + 1)),
        ).toBe('"archive.zip" exceeds the maximum attachment size of 8 MB.');
      });

      it("accepts a file the model can't read and the sandbox can't take", () => {
        // Over the sandbox artifact limit but under the storage cap: it
        // skips the sandbox and still lands in the conversation's Files panel.
        // The sandbox limit is pinned because its default tracks the storage
        // cap, which would leave this band empty.
        mockFeatureState.sandboxArtifactBytesLimit = 16 * 1024 * 1024;
        mockFeatureState.chatAttachmentStorageBytesLimit = 50 * 1024 * 1024;
        renderComposer();

        expect(
          mockUploadPolicy.validateFile?.(sized(20 * 1024 * 1024)),
        ).toBeNull();
      });

      it("falls back to the 50 MB default before /api/config resolves", () => {
        renderComposer();

        expect(mockUploadPolicy.maxFileSize).toBe(50 * 1024 * 1024);
        expect(
          mockUploadPolicy.validateFile?.(sized(50 * 1024 * 1024)),
        ).toBeNull();
        expect(
          mockUploadPolicy.validateFile?.(sized(50 * 1024 * 1024 + 1)),
        ).toBe('"archive.zip" exceeds the maximum attachment size of 50 MB.');
      });
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
        "Enable file uploads in Chat settings",
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

  describe("locked-chat composer", () => {
    it("keeps the attach button usable and shows the explainer drawer while the new-chat toggle is on", () => {
      render(
        <ArchestraPromptInput
          {...defaultProps}
          allowFileUploads={true}
          lockedChat
          onLockedChatChange={vi.fn()}
        />,
      );

      // The drawer carries the copy that used to live in the toggle tooltip.
      // It says the chat is encrypted here, not that anything is unavailable.
      const notice = screen.getByTestId(E2eTestId.LockedChatNotice);
      expect(notice).toHaveTextContent(
        /Locked chat — encrypted with a key that stays in this browser/,
      );

      // Uploads work in a locked chat — the bytes are sealed under the chat's
      // own key — so the attach button is the ordinary, usable one.
      expect(
        screen.getByTestId(E2eTestId.ChatFileUploadButton),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId(E2eTestId.ChatDisabledFileUploadButton),
      ).not.toBeInTheDocument();
    });

    it("renders no drawer and a normal attach button when locked chat is off", () => {
      render(
        <ArchestraPromptInput
          {...defaultProps}
          allowFileUploads={true}
          lockedChat={false}
          onLockedChatChange={vi.fn()}
        />,
      );

      expect(
        screen.queryByTestId(E2eTestId.LockedChatNotice),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId(E2eTestId.ChatFileUploadButton),
      ).toBeInTheDocument();
    });

    it("keeps the drawer and a usable attach button on an existing locked chat", () => {
      mockConversationState.conversation = { lockedChat: true };

      render(
        <ArchestraPromptInput
          {...defaultProps}
          conversationId="conversation-1"
          allowFileUploads={true}
        />,
      );

      expect(
        screen.getByTestId(E2eTestId.LockedChatNotice),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId(E2eTestId.ChatFileUploadButton),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId(E2eTestId.ChatDisabledFileUploadButton),
      ).not.toBeInTheDocument();
    });

    it("toggles locked chat from the composer button, whose tooltip is just the name", () => {
      mockFeatureState.lockedChatEnabled = true;
      const onLockedChatChange = vi.fn();

      render(
        <ArchestraPromptInput
          {...defaultProps}
          allowFileUploads={true}
          lockedChat={false}
          onLockedChatChange={onLockedChatChange}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Locked chat" }));
      expect(onLockedChatChange).toHaveBeenCalledWith(true);

      // The long explanation moved to the drawer; the hover stays succinct —
      // just the name plus the global shortcut.
      expect(
        screen
          .getAllByTestId("tooltip-content")
          .some((tooltip) =>
            tooltip.textContent?.trim().startsWith("Locked chat"),
          ),
      ).toBe(true);
    });

    it("claims the Alt+I handshake event and toggles the draft off and back on", () => {
      mockFeatureState.lockedChatEnabled = true;
      const onLockedChatChange = vi.fn();

      const { rerender } = render(
        <ArchestraPromptInput
          {...defaultProps}
          allowFileUploads={true}
          lockedChat
          onLockedChatChange={onLockedChatChange}
        />,
      );

      // Armed draft + shortcut: claimed (no navigation) and toggled off.
      const disarm = new Event(LOCKED_CHAT_DRAFT_SHORTCUT_EVENT, {
        cancelable: true,
      });
      let unclaimed: boolean | undefined;
      act(() => {
        unclaimed = window.dispatchEvent(disarm);
      });
      expect(unclaimed).toBe(false);
      expect(onLockedChatChange).toHaveBeenLastCalledWith(false);

      // Shortcut again on the disarmed composer: toggled back on.
      rerender(
        <ArchestraPromptInput
          {...defaultProps}
          allowFileUploads={true}
          lockedChat={false}
          onLockedChatChange={onLockedChatChange}
        />,
      );
      act(() => {
        window.dispatchEvent(
          new Event(LOCKED_CHAT_DRAFT_SHORTCUT_EVENT, { cancelable: true }),
        );
      });
      expect(onLockedChatChange).toHaveBeenLastCalledWith(true);
    });

    it("leaves the handshake event unclaimed while chatting in a conversation", () => {
      mockFeatureState.lockedChatEnabled = true;
      const onLockedChatChange = vi.fn();

      render(
        <ArchestraPromptInput
          {...defaultProps}
          conversationId="conversation-1"
          allowFileUploads={true}
          onLockedChatChange={onLockedChatChange}
        />,
      );

      let unclaimed: boolean | undefined;
      act(() => {
        unclaimed = window.dispatchEvent(
          new Event(LOCKED_CHAT_DRAFT_SHORTCUT_EVENT, { cancelable: true }),
        );
      });

      // Unclaimed → the global handler proceeds to navigate to a fresh draft.
      expect(unclaimed).toBe(true);
      expect(onLockedChatChange).not.toHaveBeenCalled();
    });
  });

  describe("turn attachment budget", () => {
    // Each file passes the per-file cap on its own, but they all ride in one
    // request body. Without this guard the send reaches the body parser and
    // dies with an opaque 413.
    const dataUrlOfBytes = (bytes: number) => ({
      url: `data:application/pdf;base64,${"A".repeat(bytes)}`,
    });

    it("blocks a send whose attachments exceed the body limit", () => {
      const onSubmit = vi.fn();
      mockFeatureState.apiBodyLimitBytes = 10 * 1024 * 1024;
      mockControllerState.value = "here are two files";
      mockControllerState.files = [
        dataUrlOfBytes(6 * 1024 * 1024),
        dataUrlOfBytes(6 * 1024 * 1024),
      ];

      render(<ArchestraPromptInput {...defaultProps} onSubmit={onSubmit} />);
      fireEvent.submit(screen.getByTestId("prompt-input"));

      expect(onSubmit).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("Send them in separate messages."),
      );
    });

    it("allows a single attachment that fits on its own", () => {
      const onSubmit = vi.fn();
      mockFeatureState.apiBodyLimitBytes = 10 * 1024 * 1024;
      mockControllerState.value = "here is one file";
      mockControllerState.files = [dataUrlOfBytes(6 * 1024 * 1024)];

      render(<ArchestraPromptInput {...defaultProps} onSubmit={onSubmit} />);
      fireEvent.submit(screen.getByTestId("prompt-input"));

      expect(onSubmit).toHaveBeenCalledTimes(1);
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

  describe("external MCP Skill attachment", () => {
    const attachment = {
      id: "11111111-1111-4111-8111-111111111111",
      mcpServerId: "33333333-3333-4333-8333-333333333333",
      uri: "skill://example/fallout/SKILL.md",
      name: "fallout-rpg",
      serverName: "TTRPG Helper",
      commandValue: "/ttrpg-helper-fallout-rpg",
      displayName: "TTRPG Helper [personal:33333333] / fallout-rpg",
    };

    it("submits identity metadata when the human slash token remains", () => {
      const onSubmit = vi.fn();
      const onRemove = vi.fn();
      mockControllerState.value =
        "/ttrpg-helper-fallout-rpg Create a campaign outline";

      render(
        <ArchestraPromptInput
          {...defaultProps}
          onSubmit={onSubmit}
          externalMcpSkillAttachment={attachment}
          onRemoveExternalMcpSkillAttachment={onRemove}
        />,
      );

      expect(screen.queryByText(/Load and use/)).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Remove attached Skill" }),
      ).not.toBeInTheDocument();
      fireEvent.submit(screen.getByTestId("prompt-input"));

      const [message, , options] = onSubmit.mock.calls[0];
      expect(message.text).toBe("Create a campaign outline");
      expect(options).toEqual({ externalMcpSkill: attachment });
      expect(onRemove).toHaveBeenCalledTimes(1);
    });

    it("detaches the MCP Skill when the slash token was deleted", () => {
      const onSubmit = vi.fn();
      const onRemove = vi.fn();
      mockControllerState.value = "Create a campaign outline";
      render(
        <ArchestraPromptInput
          {...defaultProps}
          onSubmit={onSubmit}
          externalMcpSkillAttachment={attachment}
          onRemoveExternalMcpSkillAttachment={onRemove}
        />,
      );

      fireEvent.submit(screen.getByTestId("prompt-input"));
      const [message, , options] = onSubmit.mock.calls[0];
      expect(message.text).toBe("Create a campaign outline");
      expect(options).toBeUndefined();
      expect(onRemove).toHaveBeenCalledTimes(1);
    });

    it("lets a replacement local Skill command become the source of truth", () => {
      vi.mocked(useOrganization).mockReturnValue({
        data: { skillToolsEnabled: true },
        isLoading: false,
      } as unknown as ReturnType<typeof useOrganization>);
      mockUseSkillsPaginated.mockReturnValue({
        data: {
          data: [
            { id: "local-skill", name: "Local Skill", description: "Local" },
          ],
        },
        isLoading: false,
      });
      mockControllerState.value = "/local-skill do the thing";
      const onSubmit = vi.fn();
      const onRemove = vi.fn();

      render(
        <ArchestraPromptInput
          {...defaultProps}
          onSubmit={onSubmit}
          externalMcpSkillAttachment={attachment}
          onRemoveExternalMcpSkillAttachment={onRemove}
        />,
      );
      fireEvent.submit(screen.getByTestId("prompt-input"));

      const [message, , options] = onSubmit.mock.calls[0];
      expect(message.text).toBe("do the thing");
      expect(options).toEqual({
        skill: { id: "local-skill", name: "Local Skill" },
      });
      expect(onRemove).toHaveBeenCalledTimes(1);
    });

    it("reserves the staged MCP token from later local Skill collisions", () => {
      vi.mocked(useOrganization).mockReturnValue({
        data: { skillToolsEnabled: true },
        isLoading: false,
      } as unknown as ReturnType<typeof useOrganization>);
      mockUseSkillsPaginated.mockReturnValue({
        data: {
          data: [
            {
              id: "local-collision",
              name: "TTRPG Helper Fallout RPG",
              description: "Local collision",
            },
          ],
        },
        isLoading: false,
      });
      mockControllerState.value = "/ttrpg-helper-fallout-rpg-2 local task";
      const onSubmit = vi.fn();

      render(
        <ArchestraPromptInput
          {...defaultProps}
          onSubmit={onSubmit}
          externalMcpSkillAttachment={attachment}
        />,
      );
      fireEvent.submit(screen.getByTestId("prompt-input"));

      const [message, , options] = onSubmit.mock.calls[0];
      expect(message.text).toBe("local task");
      expect(options).toEqual({
        skill: { id: "local-collision", name: "TTRPG Helper Fallout RPG" },
      });
    });

    it("lets a replacement sandbox command keep its no-LLM metadata", () => {
      mockProfileState.agent = { sandboxAvailable: true };
      mockControllerState.value = "! echo sensitive";
      const onSubmit = vi.fn();
      const onRemove = vi.fn();

      render(
        <ArchestraPromptInput
          {...defaultProps}
          onSubmit={onSubmit}
          externalMcpSkillAttachment={attachment}
          onRemoveExternalMcpSkillAttachment={onRemove}
        />,
      );
      fireEvent.submit(screen.getByTestId("prompt-input"));

      const [message, , options] = onSubmit.mock.calls[0];
      expect(message.text).toBe("! echo sensitive");
      expect(options).toEqual({ sandboxCommand: true });
      expect(onRemove).toHaveBeenCalledTimes(1);
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

    it("restores a queued external MCP Skill attachment", () => {
      const conversationId = "conv-arrowup-external-skill";
      const externalMcpSkill = {
        id: "11111111-1111-4111-8111-111111111111",
        mcpServerId: "33333333-3333-4333-8333-333333333333",
        uri: "skill://example/release/SKILL.md",
        name: "release-checklist",
        serverName: "Operations server",
        commandValue: "/operations-server-release-checklist",
        displayName: "Operations server [team:33333333] / release-checklist",
      };
      chatMessageQueue.clear(conversationId);
      chatMessageQueue.enqueue(conversationId, {
        text: "do the thing",
        externalMcpSkill,
      });
      mockControllerState.value = "";
      const onRestore = vi.fn();

      render(
        <ArchestraPromptInput
          {...defaultProps}
          conversationId={conversationId}
          onRestoreExternalMcpSkillAttachment={onRestore}
        />,
      );
      fireEvent.keyDown(screen.getByTestId(E2eTestId.ChatPromptTextarea), {
        key: "ArrowUp",
      });

      expect(mockTextInputSetInput).toHaveBeenCalledWith(
        "/operations-server-release-checklist do the thing",
      );
      expect(onRestore).toHaveBeenCalledWith(externalMcpSkill);
      chatMessageQueue.clear(conversationId);
    });

    it("leaves the queue alone on ArrowUp when the composer already has text", () => {
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

  describe("queue affordance on the submit button", () => {
    // The composer's Send/Stop face is the only thing announcing what Enter
    // will do mid-stream: with a queueable draft the submit stays an ordinary
    // Send button (status "ready") instead of turning into Stop.
    const getSubmitButton = () =>
      screen.getByTestId("prompt-submit") as HTMLButtonElement;

    it("keeps the Send face while a response streams and the composer holds a queueable draft", () => {
      mockControllerState.value = "follow-up";

      render(
        <ArchestraPromptInput
          {...defaultProps}
          status="streaming"
          onStop={vi.fn()}
          conversationId="conv-queue-face"
        />,
      );

      expect(getSubmitButton()).toHaveTextContent("Submit ready");
      // ...and with it the ordinary Send tooltip, not the Stop one.
      expect(screen.getByText(/^Send$/)).toBeInTheDocument();
      expect(screen.queryByText(/^Stop$/)).not.toBeInTheDocument();
    });

    it("clicking the Send face queues instead of stopping", () => {
      const onStop = vi.fn();
      const onSubmit = vi.fn();
      mockControllerState.value = "follow-up";

      render(
        <ArchestraPromptInput
          {...defaultProps}
          onSubmit={onSubmit}
          status="streaming"
          onStop={onStop}
          conversationId="conv-queue-click"
        />,
      );

      fireEvent.click(getSubmitButton());

      expect(onStop).not.toHaveBeenCalled();
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("keeps the Stop face while streaming with an empty composer", () => {
      const onStop = vi.fn();
      mockControllerState.value = "";

      render(
        <ArchestraPromptInput
          {...defaultProps}
          status="streaming"
          onStop={onStop}
          conversationId="conv-stop-face"
        />,
      );

      expect(getSubmitButton()).toHaveTextContent("Submit streaming");
      expect(screen.getByText(/^Stop$/)).toBeInTheDocument();

      fireEvent.click(getSubmitButton());
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("keeps the Stop face when attachments are staged, since they cannot be queued", () => {
      mockControllerState.value = "follow-up";
      mockControllerState.files = [{ url: "blob:attachment" }];

      render(
        <ArchestraPromptInput
          {...defaultProps}
          status="streaming"
          onStop={vi.fn()}
          conversationId="conv-queue-attachments"
        />,
      );

      expect(getSubmitButton()).toHaveTextContent("Submit streaming");
    });

    it("keeps the Stop face on the new-chat composer, which has no conversation to queue into", () => {
      mockControllerState.value = "first message";

      render(
        <ArchestraPromptInput
          {...defaultProps}
          status="streaming"
          onStop={vi.fn()}
        />,
      );

      expect(getSubmitButton()).toHaveTextContent("Submit streaming");
    });
  });

  describe("context compaction", () => {
    // The Enter path is routed through the submit button's disabled state (the
    // textarea refuses to requestSubmit while the button is disabled), so the
    // button assertions below pin the keyboard contract too.
    const getSubmitButton = (): HTMLButtonElement => {
      const button = document.querySelector('button[type="submit"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("submit button not found");
      }
      return button;
    };

    it("keeps the composer usable mid-stream when queueing can absorb the message", () => {
      const onSubmit = vi.fn();

      render(
        <ArchestraPromptInput
          {...defaultProps}
          onSubmit={onSubmit}
          status="streaming"
          conversationId="conv-compacting-queue"
          isContextCompacting
        />,
      );

      expect(
        screen.getByTestId(E2eTestId.ChatPromptTextarea),
      ).not.toBeDisabled();
      expect(getSubmitButton()).not.toBeDisabled();

      // A submit during compaction still reaches the consumer (which queues it).
      mockControllerState.value = "queued while compacting";
      fireEvent.submit(screen.getByTestId("prompt-input"));
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("locks the composer during compaction when there is no conversation to queue into", () => {
      render(
        <ArchestraPromptInput
          {...defaultProps}
          status="streaming"
          isContextCompacting
        />,
      );

      expect(screen.getByTestId(E2eTestId.ChatPromptTextarea)).toBeDisabled();
      expect(getSubmitButton()).toBeDisabled();
    });

    // A manual `/compact` runs over REST with the SDK idle, so nothing about
    // it is "in flight" from the composer's point of view — but the thread is
    // being rewritten, and the message has a queue to wait in.
    it("keeps the composer usable during an idle (manual) compaction", () => {
      const onSubmit = vi.fn();

      render(
        <ArchestraPromptInput
          {...defaultProps}
          onSubmit={onSubmit}
          status="ready"
          conversationId="conv-compacting-idle"
          isContextCompacting
        />,
      );

      expect(
        screen.getByTestId(E2eTestId.ChatPromptTextarea),
      ).not.toBeDisabled();
      expect(getSubmitButton()).not.toBeDisabled();

      mockControllerState.value = "queued during manual compaction";
      fireEvent.submit(screen.getByTestId("prompt-input"));
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
  });
});
