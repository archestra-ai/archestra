import type { SupportedProvider } from "@shared";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseLlmModelsByProvider = vi.fn();
const capturedKeywords = new Map<string, string[]>();

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModelsByProvider: (...args: unknown[]) =>
    mockUseLlmModelsByProvider(...args),
  useSyncLlmModels: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/chat/use-chat-preferences", () => ({
  resolveAutoSelectedModel: vi.fn(() => null),
}));

vi.mock("@/components/ui/command", () => ({
  Command: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandDialog: () => null,
  CommandEmpty: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandGroup: ({
    children,
    heading,
  }: {
    children?: React.ReactNode;
    heading?: string;
  }) => <div data-heading={heading}>{children}</div>,
  CommandInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
  CommandItem: ({
    value,
    keywords,
    children,
    ...props
  }: {
    value: string;
    keywords?: string[];
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => {
    capturedKeywords.set(value, keywords ?? []);
    return (
      <div
        data-testid={`cmd-item-${value}`}
        data-keywords={keywords?.join(",")}
        {...props}
      >
        {children}
      </div>
    );
  },
  CommandList: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandSeparator: () => <hr />,
  CommandShortcut: ({ children }: { children?: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogContent: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children?: React.ReactNode }) => (
    <h1>{children}</h1>
  ),
  DialogClose: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTrigger: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipContent: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/toggle", () => ({
  Toggle: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ai-elements/prompt-input", () => ({
  PromptInputButton: ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/model-badges", () => ({
  FreeModelBadge: () => <span>Free</span>,
  LatestModelBadge: () => <span>Latest</span>,
  UnknownCapabilitiesBadge: () => <span>Unknown</span>,
}));

vi.mock("@shared", () => ({
  compareModelsForDisplay: () => 0,
  E2eTestId: { ChatModelSelectorTrigger: "chat-model-selector-trigger" },
  isOpenRouterLatestAlias: () => false,
  providerDisplayNames: { openai: "OpenAI" } as Record<
    SupportedProvider,
    string
  >,
}));

vi.mock("lucide-react", () => ({
  CheckIcon: () => <span data-testid="check-icon" />,
  CopyIcon: () => <span data-testid="copy-icon" />,
  DollarSign: () => <span data-testid="dollar-sign" />,
  FileText: () => <span data-testid="file-text" />,
  ImageIcon: () => <span data-testid="image-icon" />,
  Layers: () => <span data-testid="layers" />,
  Loader2: () => <span data-testid="loader-2" />,
  Mic: () => <span data-testid="mic" />,
  RefreshCw: () => <span data-testid="refresh-cw" />,
  Settings2: () => <span data-testid="settings-2" />,
  Video: () => <span data-testid="video" />,
  XIcon: () => <span data-testid="x-icon" />,
}));

// Import after mocks
import { ModelSelector } from "./model-selector";

describe("ModelSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedKeywords.clear();
    mockUseLlmModelsByProvider.mockReturnValue({
      modelsByProvider: {},
      isPending: false,
      isPlaceholderData: false,
    });
  });

  const mockModel = {
    dbId: "550e8400-e29b-41d4-a716-446655440000",
    id: "gpt-5.5",
    displayName: "GPT 5.5",
    provider: "openai" as SupportedProvider,
    isBest: false,
    isFree: false,
    capabilities: null,
  };

  it("passes display name and model ID as keywords for cmdk search filtering", () => {
    mockUseLlmModelsByProvider.mockReturnValue({
      modelsByProvider: {
        openai: [mockModel],
      },
      isPending: false,
      isPlaceholderData: false,
    });

    render(
      <ModelSelector
        selectedModel=""
        onModelChange={vi.fn()}
        enabled={false}
      />,
    );

    const modelValue = "openai:550e8400-e29b-41d4-a716-446655440000";
    expect(capturedKeywords.get(modelValue)).toEqual([
      "GPT 5.5",
      "gpt-5.5",
      "OpenAI",
    ]);
  });

  it("makes models searchable by their actual ID instead of only the UUID dbId", () => {
    mockUseLlmModelsByProvider.mockReturnValue({
      modelsByProvider: {
        openai: [
          {
            ...mockModel,
            id: "gpt-5.5-pro",
            displayName: "GPT 5.5 Pro",
          },
        ],
      },
      isPending: false,
      isPlaceholderData: false,
    });

    render(
      <ModelSelector
        selectedModel=""
        onModelChange={vi.fn()}
        enabled={false}
      />,
    );

    const modelValue = "openai:550e8400-e29b-41d4-a716-446655440000";
    const keywords = capturedKeywords.get(modelValue);
    expect(keywords).toContain("GPT 5.5 Pro");
    expect(keywords).toContain("gpt-5.5-pro");
  });
});
