// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

"use client";

import {
  DocsPage,
  getDocsUrl,
  type SupportedProvider,
} from "@archestra/shared";
import { Info, Settings2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import type { ModelWithApiKeys } from "@/lib/llm-models.query";

const DISMISSED_MODEL_STORAGE_PREFIX =
  "knowledge-image-embedding-notice-dismissed-model";

export function EmbeddingModelImageSupportNotice({
  modelId,
  provider,
  dismissalScope,
  supportsImages,
  showSettingsLink = true,
  className,
}: {
  modelId: string;
  provider: SupportedProvider;
  dismissalScope: string;
  supportsImages: boolean | null;
  showSettingsLink?: boolean;
  className?: string;
}) {
  const modelKey = `${provider}/${modelId}`;
  const storageKey = `${DISMISSED_MODEL_STORAGE_PREFIX}:${dismissalScope}`;
  const dismissalId = `${storageKey}:${modelKey}`;
  const [dismissalState, setDismissalState] = useState<{
    id: string;
    fingerprint: string | null;
    dismissed: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getModelFingerprint(modelKey)
      .then((fingerprint) => {
        if (cancelled) return;
        const storedFingerprint = readDismissedModelFingerprint(storageKey);
        if (storedFingerprint && storedFingerprint !== fingerprint) {
          clearDismissedModelFingerprint(storageKey);
        }
        setDismissalState({
          id: dismissalId,
          fingerprint,
          dismissed: storedFingerprint === fingerprint,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setDismissalState({
            id: dismissalId,
            fingerprint: null,
            dismissed: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dismissalId, modelKey, storageKey]);

  if (
    supportsImages !== false ||
    dismissalState?.id !== dismissalId ||
    dismissalState.dismissed
  ) {
    return null;
  }

  const handleDismiss = () => {
    if (dismissalState.fingerprint) {
      writeDismissedModelFingerprint(storageKey, dismissalState.fingerprint);
    }
    setDismissalState({ ...dismissalState, dismissed: true });
  };

  return (
    <InlineNotice role="note" variant="warning" className={className}>
      <Info />
      <code className="break-all font-medium">{modelKey}</code>
      <InlineNoticeText className="flex-1 basis-64">
        Handles text only. Choose a multimodal embedding model to sync supported
        image files.{" "}
        <a
          href={getDocsUrl(
            DocsPage.PlatformKnowledgeSettings,
            "image-embedding",
          )}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted underline-offset-4 hover:decoration-solid"
        >
          Learn more
        </a>
      </InlineNoticeText>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {showSettingsLink && (
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings/knowledge#embedding-configuration">
              <Settings2 className="size-3.5" />
              <span>Embedding settings</span>
            </Link>
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={handleDismiss}>
          <span>Dismiss</span>
        </Button>
      </div>
    </InlineNotice>
  );
}

export function embeddingModelSupportsImages(
  model: Pick<
    ModelWithApiKeys,
    "inputModalities" | "embeddingClientImageCapable"
  >,
): boolean {
  return (
    model.inputModalities?.includes("image") === true &&
    model.embeddingClientImageCapable !== false
  );
}

function readDismissedModelFingerprint(storageKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function writeDismissedModelFingerprint(
  storageKey: string,
  fingerprint: string,
) {
  try {
    localStorage.setItem(storageKey, fingerprint);
  } catch {
    // Keep the in-memory dismissal when browser storage is unavailable.
  }
}

function clearDismissedModelFingerprint(storageKey: string) {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // A blocked storage backend is already equivalent to no persisted dismissal.
  }
}

async function getModelFingerprint(modelKey: string) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(modelKey),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
