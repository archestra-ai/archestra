"use client";

import { Check, Copy, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import {
  usePollXaiSubscriptionDeviceFlow,
  useStartXaiSubscriptionDeviceFlow,
  type XaiSubscriptionDeviceStart,
} from "@/lib/xai-subscription-auth.query";

interface XaiSubscriptionSignInProps {
  /**
   * Receives the encoded X Premium credential once the device flow completes;
   * the form stores it as the xAI provider key.
   */
  onCredential: (credential: string) => void;
  disabled?: boolean;
}

/**
 * "Sign in with X" device flow: shows a one-time code the user enters at
 * accounts.x.ai, then polls until xAI hands back the OAuth credential that
 * becomes the xAI (X Premium subscription) provider key. Works on hosted
 * deployments and custom domains — no localhost loopback required.
 *
 * Unlike the ChatGPT/Codex flow there is no account setting to turn on first,
 * so this is a two-step card rather than three.
 */
export function XaiSubscriptionSignIn({
  onCredential,
  disabled,
}: XaiSubscriptionSignInProps) {
  const start = useStartXaiSubscriptionDeviceFlow();
  const poll = usePollXaiSubscriptionDeviceFlow();
  const [flow, setFlow] = useState<XaiSubscriptionDeviceStart | null>(null);
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
    // Never poll faster than the device-flow interval (>= 5s) or xAI only
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
        result = await pollRef.current({ deviceCode: flow.deviceCode });
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
  // xAI tab here — opening a tab steals focus, and the Clipboard API refuses to
  // write while the document is unfocused, so an auto-copy would silently fail.
  // The copy + open happen together in copyCodeAndOpen (a fresh gesture).
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

  // Step 2: copy the code WHILE the page is still focused, then open the xAI
  // device-login page. Ordering matters — copying before window.open keeps the
  // document focused for the clipboard write.
  const copyCodeAndOpen = async (deviceFlow: XaiSubscriptionDeviceStart) => {
    try {
      await copyToClipboard(deviceFlow.userCode);
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
        <Check className="h-4 w-4 text-green-500" />X account linked — you can
        save the key now.
      </p>
    );
  }

  if (flow) {
    return (
      <ol className="list-none space-y-3 rounded-md border p-3 text-xs text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">
            1. Copy this code and open X's device sign-in.
          </span>{" "}
          Paste it, then approve with the account that has your X Premium
          (SuperGrok) subscription.
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copyCodeAndOpen(flow)}
            >
              <XLogo className="mr-2 h-4 w-4" />
              Copy code &amp; open X
            </Button>
            <button
              type="button"
              className="flex items-center gap-1 rounded bg-muted px-2 py-1 font-mono text-sm tracking-widest hover:bg-muted/70"
              aria-label="Copy code"
              onClick={async () => {
                try {
                  await copyToClipboard(flow.userCode);
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
          <XLogo className="mr-2 h-4 w-4" />
        )}
        <span>Sign in with X</span>
      </Button>
      {expired && (
        <p className="text-xs text-destructive">
          The sign-in expired before it was authorized — try again.
        </p>
      )}
    </div>
  );
}

/** X's wordmark glyph (lucide has no brand icon for it). */
function XLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
