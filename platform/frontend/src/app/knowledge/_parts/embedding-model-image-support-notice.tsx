// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

"use client";

import {
  DocsPage,
  getDocsUrl,
  type SupportedProvider,
} from "@archestra/shared";
import { Info, Settings2 } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ModelWithApiKeys } from "@/lib/llm-models.query";
import { cn } from "@/lib/utils";

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
  if (supportsImages !== false) return null;

  const modelKey = `${provider}/${modelId}`;
  return (
    <KnowledgeModelCapabilityNotice
      modelKey={modelKey}
      dismissalPrefix={DISMISSED_MODEL_STORAGE_PREFIX}
      dismissalScope={dismissalScope}
      settingsHref="/settings/knowledge#embedding-configuration"
      settingsLabel="Embedding settings"
      showSettingsLink={showSettingsLink}
      className={className}
    >
      Handles text only. Choose a multimodal embedding model to sync supported
      image files.{" "}
      <a
        href={getDocsUrl(DocsPage.PlatformKnowledge, "image-embedding")}
        target="_blank"
        rel="noreferrer"
        className="text-foreground underline decoration-dotted underline-offset-4 hover:decoration-solid"
      >
        Learn more
      </a>
    </KnowledgeModelCapabilityNotice>
  );
}

export function KnowledgeModelCapabilityNotice({
  modelKey,
  dismissalPrefix,
  dismissalScope,
  settingsHref,
  settingsLabel,
  showSettingsLink = true,
  className,
  children,
}: {
  modelKey: string;
  dismissalPrefix: string;
  dismissalScope?: string;
  settingsHref?: string;
  settingsLabel?: string;
  showSettingsLink?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const storageKey = dismissalScope
    ? `${dismissalPrefix}:${dismissalScope}`
    : null;
  const dismissalId = `${storageKey ?? dismissalPrefix}:${modelKey}`;
  const [dismissalState, setDismissalState] = useState<{
    id: string;
    fingerprint: string | null;
    dismissed: boolean;
  } | null>(null);

  useEffect(() => {
    if (!storageKey) {
      setDismissalState({
        id: dismissalId,
        fingerprint: null,
        dismissed: false,
      });
      return;
    }
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

  if (dismissalState?.id !== dismissalId || dismissalState.dismissed) {
    return null;
  }

  const handleDismiss = () => {
    if (storageKey && dismissalState.fingerprint) {
      writeDismissedModelFingerprint(storageKey, dismissalState.fingerprint);
    }
    setDismissalState({ ...dismissalState, dismissed: true });
  };

  return (
    <div
      role="note"
      className={cn(
        "flex flex-col gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground sm:flex-row sm:items-center",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Info className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-foreground">
            <code className="break-all">{modelKey}</code>
          </p>
          <p className="leading-relaxed">{children}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1 self-end sm:self-auto">
        {showSettingsLink && settingsHref && settingsLabel && (
          <Button variant="outline" size="sm" asChild>
            <Link href={settingsHref}>
              <Settings2 className="size-3.5" />
              <span>{settingsLabel}</span>
            </Link>
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={handleDismiss}>
          <span>Dismiss</span>
        </Button>
      </div>
    </div>
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
