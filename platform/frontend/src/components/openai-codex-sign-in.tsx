"use client";

import { Check, Copy, Info, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type OpenaiCodexDeviceStart,
  usePollOpenaiCodexDeviceFlow,
  useStartOpenaiCodexDeviceFlow,
} from "@/lib/openai-codex-auth.query";

/**
 * ChatGPT security settings, where the account owner must turn on "Allow device
 * code login" before the device flow can be approved (it is off by default).
 */
const CHATGPT_SECURITY_SETTINGS_URL = "https://chatgpt.com/settings/security";

interface OpenaiCodexSignInProps {
  /**
   * Receives the encoded ChatGPT-subscription credential once the device flow
   * completes; the form stores it as the OpenAI provider key.
   */
  onCredential: (credential: string) => void;
  disabled?: boolean;
}

/**
 * "Sign in with ChatGPT" device flow: shows a one-time code the user enters at
 * auth.openai.com, then polls until OpenAI hands back the OAuth credential that
 * becomes the OpenAI (ChatGPT subscription) provider key. Works on hosted
 * deployments and custom domains — no localhost loopback required.
 */
export function OpenaiCodexSignIn({
  onCredential,
  disabled,
}: OpenaiCodexSignInProps) {
  const start = useStartOpenaiCodexDeviceFlow();
  const poll = usePollOpenaiCodexDeviceFlow();
  const [flow, setFlow] = useState<OpenaiCodexDeviceStart | null>(null);
  const [completed, setCompleted] = useState(false);
  const [expired, setExpired] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  // Mutation fns in a ref so the polling effect doesn't restart per render.
  const pollRef = useRef(poll.mutateAsync);
  pollRef.current = poll.mutateAsync;
  const onCredentialRef = useRef(onCredential);
  onCredentialRef.current = onCredential;
  const copyResetTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(copyResetTimeout.current), []);

  useEffect(() => {
    if (!flow || completed) return;

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>;
    // Never poll faster than the device-flow interval (>= 5s) or OpenAI only
    // returns slow_down.
    let intervalMs = Math.max(flow.interval, 5) * 1000;
    const deadline = Date.now() + flow.expiresIn * 1000;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() >= deadline) {
        setExpired(true);
        setFlow(null);
        return;
      }
      let result: Awaited<ReturnType<typeof pollRef.current>>;
      try {
        result = await pollRef.current({
          deviceAuthId: flow.deviceAuthId,
          userCode: flow.userCode,
        });
      } catch {
        // network-level failure — transient; keep polling until the deadline
        if (!cancelled) timeout = setTimeout(tick, intervalMs);
        return;
      }
      if (cancelled) return;
      if (!result) {
        // request failed (toast already shown) — abandon this flow
        setFlow(null);
        return;
      }
      if (result.status === "complete") {
        setCompleted(true);
        onCredentialRef.current(result.credential);
        return;
      }
      if (result.status === "slow_down") {
        intervalMs += 5000;
      }
      timeout = setTimeout(tick, intervalMs);
    };

    timeout = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [flow, completed]);

  // Step 1: fetch the device code and show it. We deliberately do NOT open the
  // OpenAI tab here — opening a tab steals focus, and the Clipboard API refuses
  // to write while the document is unfocused, so an auto-copy would silently
  // fail. The copy + open happen together in copyCodeAndOpen (a fresh gesture).
  const begin = async () => {
    setExpired(false);
    setCompleted(false);
    try {
      const result = await start.mutateAsync();
      if (result) setFlow(result);
    } catch {
      // network-level failure — leave the button enabled for another attempt
    }
  };

  const markCopied = () => {
    setCodeCopied(true);
    clearTimeout(copyResetTimeout.current);
    copyResetTimeout.current = setTimeout(() => setCodeCopied(false), 2000);
  };

  // Step 2: copy the code WHILE the page is still focused, then open the OpenAI
  // device-login page. Ordering matters — copying before window.open keeps the
  // document focused for the clipboard write.
  const copyCodeAndOpen = async (deviceFlow: OpenaiCodexDeviceStart) => {
    try {
      await navigator.clipboard.writeText(deviceFlow.userCode);
      markCopied();
    } catch {
      // clipboard blocked (permissions/focus) — the visible code + copy button
      // remain as a fallback
    }
    window.open(deviceFlow.verificationUri, "_blank", "noopener,noreferrer");
  };

  if (completed) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Check className="h-4 w-4 text-green-500" />
        ChatGPT account linked — you can save the key now.
      </p>
    );
  }

  if (flow) {
    return (
      <ol className="list-none space-y-3 rounded-md border p-3 text-xs text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">
            1. Enable device code authorization (one-time).
          </span>{" "}
          Turn on "Enable device code authorization for Codex" in ChatGPT
          Settings, or approval is blocked.
          <a
            href={CHATGPT_SECURITY_SETTINGS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1 underline underline-offset-2 hover:text-foreground"
          >
            Open settings
          </a>
        </li>
        <li>
          <span className="font-medium text-foreground">
            2. Copy this code and open ChatGPT's device sign-in.
          </span>{" "}
          Paste it, then approve with the account that has your Codex/ChatGPT
          subscription.
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copyCodeAndOpen(flow)}
            >
              <OpenAiLogo className="mr-2 h-4 w-4" />
              Copy code &amp; open ChatGPT
            </Button>
            <button
              type="button"
              className="flex items-center gap-1 rounded bg-muted px-2 py-1 font-mono text-sm tracking-widest hover:bg-muted/70"
              aria-label="Copy code"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(flow.userCode);
                  markCopied();
                } catch {
                  // clipboard blocked — code stays visible to copy manually
                }
              }}
            >
              {flow.userCode}
              {codeCopied ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
          </div>
        </li>
        <li className="flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          Waiting for authorization…
        </li>
      </ol>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || start.isPending}
        onClick={begin}
      >
        {start.isPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <OpenAiLogo className="mr-2 h-4 w-4" />
        )}
        Sign in with ChatGPT
      </Button>
      <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Make sure{" "}
          <code className="rounded border bg-background px-1.5 py-0.5 font-mono text-xs text-foreground">
            device code authorization
          </code>{" "}
          is enabled in{" "}
          <a
            href={CHATGPT_SECURITY_SETTINGS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground underline underline-offset-2"
          >
            ChatGPT Security Settings
          </a>
          .
        </span>
      </div>
      {expired && (
        <p className="text-xs text-destructive">
          The sign-in expired before it was authorized — try again.
        </p>
      )}
    </div>
  );
}

/** OpenAI's blossom mark (lucide has no brand icon for it). */
function OpenAiLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M22.28 9.82a5.98 5.98 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6 6 0 0 0 4.98 4.18a5.98 5.98 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .52 4.91 6.05 6.05 0 0 0 6.51 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.5 4.5 0 0 1-4.494 4.493zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071.007L4.14 13.762A4.5 4.5 0 0 1 2.34 7.9zm16.597 3.855-5.833-3.387L15.11 7.2a.076.076 0 0 1 .071-.006l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.398-.66zm2.01-3.023-.142-.086-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zM8.31 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.706 5.46a.795.795 0 0 0-.393.681l-.003 6.723zm1.097-2.365 2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5-.005-3z" />
    </svg>
  );
}
