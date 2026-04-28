"use client";

import { render, screen } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySettings } from "./memory-settings";

const mutateAsyncMock = vi.fn();

vi.mock("@/components/llm-provider-api-key-form", () => ({
  PROVIDER_CONFIG: {
    openai: {
      icon: "/openai.svg",
      name: "OpenAI",
    },
  },
}));

vi.mock("@/components/llm-model-select", () => ({
  LlmModelSearchableSelect: ({
    placeholder,
    value,
  }: {
    placeholder: string;
    value: string;
  }) => <div>{value || placeholder}</div>,
}));

vi.mock("@/components/llm-provider-options", () => ({
  LlmProviderApiKeyOptionLabel: ({
    providerName,
    keyName,
  }: {
    providerName: string;
    keyName: string;
  }) => (
    <span>
      {providerName} {keyName}
    </span>
  ),
  LlmProviderApiKeySelectItems: () => null,
}));

vi.mock("@/components/roles/with-permissions", () => ({
  WithPermissions: ({
    children,
  }: {
    children: (args: { hasPermission: boolean }) => React.ReactNode;
  }) => children({ hasPermission: true }),
}));

vi.mock("@/components/settings/settings-block", () => ({
  SettingsBlock: ({
    title,
    description,
    control,
  }: {
    title: React.ReactNode;
    description?: React.ReactNode;
    control: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      <div>{control}</div>
    </section>
  ),
  SettingsSectionStack: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SettingsSaveBar: ({ hasChanges }: { hasChanges: boolean }) =>
    hasChanges ? <div>Unsaved changes</div> : null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: ({
    children,
    placeholder,
  }: {
    children?: React.ReactNode;
    placeholder?: string;
  }) => <span>{children ?? placeholder}</span>,
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/lib/llm-models.query", () => ({
  useLlmModels: () => ({
    data: [
      {
        id: "gpt-4.1-mini",
        provider: "openai",
        displayName: "GPT-4.1 Mini",
      },
    ],
  }),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: () => ({
    data: [
      {
        id: "key-1",
        name: "org key",
        provider: "openai",
        scope: "org",
      },
    ],
  }),
}));

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => ({
    data: {
      memoryExtractionEnabled: true,
      memoryInjectionEnabled: true,
      memoryIdleDelaySeconds: 300,
      memoryExtractorMaxTokens: 800,
      memoryExtractorModel: "gpt-4.1-mini",
      memoryExtractorChatApiKeyId: "key-1",
      memoryInjectionTokenBudget: 600,
      memoryInjectionTopK: 10,
      memoryTombstoneTtlDays: 90,
      memoryCandidateTtlDays: 30,
      memoryMaxContentLength: 500,
      memoryMaxCandidatesPerExtraction: 5,
    },
  }),
  useUpdateMemorySettings: () => ({
    mutateAsync: mutateAsyncMock,
    isPending: false,
  }),
}));

describe("MemorySettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("separates the extractor model controls from the rest of extractor settings", () => {
    render(<MemorySettings />);

    expect(screen.getByText("Extractor model")).toBeInTheDocument();
    expect(screen.getByText("Extraction behavior")).toBeInTheDocument();
    expect(screen.getByText("Reset extractor model")).toBeInTheDocument();
    expect(
      screen.getByText("Post-conversation extraction"),
    ).toBeInTheDocument();
  });
});
