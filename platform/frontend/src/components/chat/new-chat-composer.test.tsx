import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewChatComposer } from "./new-chat-composer";

const state = vi.hoisted(() => ({
  promptProps: null as Record<string, unknown> | null,
}));

vi.mock("@/app/chat/prompt-input", () => ({
  default: (props: Record<string, unknown>) => {
    state.promptProps = props;
    return (
      <button
        type="button"
        onClick={() =>
          (props.onSubmit as (message: unknown) => void)({
            text: "Run the project task",
            files: [
              {
                type: "file",
                filename: "brief.txt",
                mediaType: "text/plain",
                url: "data:text/plain;base64,YnJpZWY=",
              },
            ],
          })
        }
      >
        Submit run
      </button>
    );
  },
}));

vi.mock("@/components/agent-runtime-credential-prompt", () => ({
  AgentRuntimeCredentialPrompt: () => <div>Credentials required</div>,
}));

vi.mock("@/lib/agent-runtime.query", () => ({
  useAgentRuntimePreflight: () => ({
    data: { ready: true, missing: [], misconfigured: [] },
    isPending: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/lib/agent.query", () => ({
  useDefaultAgentId: () => ({ data: null }),
  useChatAgents: () => ({
    data: [
      {
        id: "runtime-agent",
        name: "Builder",
        runtime: { credentials: [] },
        llmApiKeyId: null,
      },
    ],
  }),
}));

vi.mock("@/lib/chat/chat.query", () => ({
  useMemberDefaultModel: () => ({ data: null }),
}));

vi.mock("@/lib/chat/use-initial-chat-model-state.hook", () => ({
  useInitialChatModelState: () => ({
    agentId: "runtime-agent",
    modelId: "model-1",
    apiKeyId: null,
    provider: "openai",
    modelSource: "agent",
    setApiKeyId: vi.fn(),
    onAgentChange: vi.fn(),
    onModelChange: vi.fn(),
    onProviderChange: vi.fn(),
    onResetModelOverride: vi.fn(),
  }),
}));

vi.mock("@/lib/config/config.query", () => ({
  useFeature: () => true,
}));

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModels: () => ({ data: [] }),
  useLlmModelsByProvider: () => ({
    modelsByProvider: {},
    isPending: false,
  }),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useLlmProviderApiKeys: () => ({ data: [] }),
}));

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => ({
    data: { allowChatFileUploads: true },
    isPending: false,
  }),
}));

vi.mock("@/lib/view-transition", () => ({
  ViewTransition: ({ children }: { children: React.ReactNode }) => children,
}));

describe("NewChatComposer", () => {
  beforeEach(() => {
    state.promptProps = null;
  });

  it("submits an Agent Runtime agent with its files and runtime mode", () => {
    const onSubmit = vi.fn();
    render(<NewChatComposer onSubmit={onSubmit} />);

    expect(state.promptProps).toMatchObject({
      runtimeMode: true,
      runtimeAgentName: "Builder",
      sendDisabled: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit run" }));

    expect(onSubmit).toHaveBeenCalledWith({
      text: "Run the project task",
      agentId: "runtime-agent",
      modelId: "model-1",
      apiKeyId: null,
      files: [
        {
          type: "file",
          filename: "brief.txt",
          mediaType: "text/plain",
          url: "data:text/plain;base64,YnJpZWY=",
        },
      ],
      runtimeMode: true,
    });
  });
});
