// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/lib/auth/auth.query";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useOrganization } from "@/lib/organization.query";
import { ConnectorEmbeddingModelNotice } from "./connector-embedding-model-notice";

vi.mock("@/lib/llm-models.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");

const EMBEDDING_API_KEY_ID = "embedding-key";
const EMBEDDING_MODEL_ID = "text-embedding-model";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("crypto", {
    subtle: {
      digest: vi.fn(
        async (_algorithm: AlgorithmIdentifier, data: BufferSource) => {
          const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
          return Uint8Array.from(bytes, (byte) => byte ^ 0xff).buffer;
        },
      ),
    },
  });
  vi.mocked(useOrganization).mockReturnValue({
    data: {
      id: "organization-1",
      embeddingChatApiKeyId: EMBEDDING_API_KEY_ID,
      embeddingModel: EMBEDDING_MODEL_ID,
    },
  } as ReturnType<typeof useOrganization>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as ReturnType<typeof useSession>);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConnectorEmbeddingModelNotice", () => {
  it("shows a quiet note with settings and documentation links for a text-only model", async () => {
    mockEmbeddingModel({
      inputModalities: ["text"],
      embeddingClientImageCapable: false,
    });

    render(<ConnectorEmbeddingModelNotice connectorType="gdrive" />);

    expect(await screen.findByRole("note")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("openai/text-embedding-model");
    expect(note).toHaveTextContent("Handles text only");
    expect(
      screen.getByText(/choose a multimodal embedding model/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Embedding settings" }),
    ).toHaveAttribute("href", "/settings/knowledge#embedding-configuration");
    expect(screen.getByRole("link", { name: "Learn more" })).toHaveAttribute(
      "href",
      getDocsUrl(DocsPage.PlatformKnowledge, "image-embedding"),
    );
  });

  it("warns when model metadata declares images but its embedding client cannot send them", async () => {
    mockEmbeddingModel({
      inputModalities: ["text", "image"],
      embeddingClientImageCapable: false,
    });

    render(<ConnectorEmbeddingModelNotice connectorType="gdrive" />);

    expect(await screen.findByRole("note")).toBeInTheDocument();
  });

  it("renders nothing for image-capable embedding models", () => {
    for (const embeddingClientImageCapable of [true, null]) {
      mockEmbeddingModel({
        inputModalities: ["text", "image"],
        embeddingClientImageCapable,
      });

      const { container, unmount } = render(
        <ConnectorEmbeddingModelNotice connectorType="gdrive" />,
      );

      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("renders nothing until the configured model can be resolved", () => {
    vi.mocked(useModelsWithApiKeys).mockReturnValue({
      data: undefined,
    } as ReturnType<typeof useModelsWithApiKeys>);

    const { container } = render(
      <ConnectorEmbeddingModelNotice connectorType="gdrive" />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the note dismissed until the embedding model changes", async () => {
    const user = userEvent.setup();
    mockEmbeddingModel({
      inputModalities: ["text"],
      embeddingClientImageCapable: false,
    });

    const { unmount } = render(
      <ConnectorEmbeddingModelNotice connectorType="gdrive" />,
    );
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    const storedFingerprint = localStorage.getItem(localStorage.key(0) ?? "");
    expect(storedFingerprint).toMatch(/^[0-9a-f]+$/);
    expect(storedFingerprint).not.toContain(EMBEDDING_MODEL_ID);

    unmount();
    const { rerender } = render(
      <ConnectorEmbeddingModelNotice connectorType="gdrive" />,
    );
    await waitFor(() => {
      expect(globalThis.crypto.subtle.digest).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    vi.mocked(useOrganization).mockReturnValue({
      data: {
        id: "organization-1",
        embeddingChatApiKeyId: EMBEDDING_API_KEY_ID,
        embeddingModel: "replacement-model",
      },
    } as ReturnType<typeof useOrganization>);
    mockEmbeddingModel({
      modelId: "replacement-model",
      inputModalities: ["text"],
      embeddingClientImageCapable: false,
    });
    rerender(<ConnectorEmbeddingModelNotice connectorType="gdrive" />);

    expect(await screen.findByRole("note")).toBeInTheDocument();
  });

  it("does not show on connectors that cannot ingest images", () => {
    const { container } = render(
      <ConnectorEmbeddingModelNotice connectorType="jira" />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("scopes dismissal to the signed-in user", async () => {
    const user = userEvent.setup();
    mockEmbeddingModel({
      inputModalities: ["text"],
      embeddingClientImageCapable: false,
    });
    const { rerender } = render(
      <ConnectorEmbeddingModelNotice connectorType="gdrive" />,
    );
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));

    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-2" } },
    } as ReturnType<typeof useSession>);
    rerender(<ConnectorEmbeddingModelNotice connectorType="gdrive" />);

    expect(await screen.findByRole("note")).toBeInTheDocument();
  });
});

function mockEmbeddingModel(params: {
  modelId?: string;
  inputModalities: Array<"text" | "image">;
  embeddingClientImageCapable: boolean | null;
}) {
  vi.mocked(useModelsWithApiKeys).mockReturnValue({
    data: [
      {
        modelId: params.modelId ?? EMBEDDING_MODEL_ID,
        provider: "openai",
        apiKeys: [{ id: EMBEDDING_API_KEY_ID }],
        inputModalities: params.inputModalities,
        embeddingClientImageCapable: params.embeddingClientImageCapable,
      },
    ],
  } as ReturnType<typeof useModelsWithApiKeys>);
}
