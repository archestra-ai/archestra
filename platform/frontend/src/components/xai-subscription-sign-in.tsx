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
   * Receives the encoded SuperGrok credential once the device flow completes;
   * the form stores it as the xAI provider key.
   */
  onCredential: (credential: string) => void | Promise<void>;
  disabled?: boolean;
}

/**
 * "Sign in with Grok" device flow: shows a one-time code the user enters at
 * accounts.x.ai, then polls until xAI hands back the OAuth credential that
 * becomes the SuperGrok provider key. Works on hosted
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
        try {
          await onCredentialRef.current(result.credential);
          if (!cancelled) setCompleted(true);
        } catch {
          // Persistence failed after OAuth completed. The mutation already
          // surfaced the error; reset to a retryable sign-in instead of
          // claiming a key exists when no Save control is available.
          if (!cancelled) setFlow(null);
        }
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
        <Check className="h-4 w-4 text-green-500" />
        <span>Grok account linked — you can save the key now.</span>
      </p>
    );
  }

  if (flow) {
    return (
      <ol className="list-none space-y-3 rounded-md border p-3 text-xs text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">
            1. Copy this code and open Grok's device sign-in.
          </span>{" "}
          Paste it, then approve with the account that has your SuperGrok
          subscription.
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copyCodeAndOpen(flow)}
            >
              <GrokLogo className="mr-2 h-4 w-4" />
              Copy code &amp; open Grok
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
          <GrokLogo className="mr-2 h-4 w-4" />
        )}
        <span>Sign in with Grok</span>
      </Button>
      {expired && (
        <p className="text-xs text-destructive">
          The sign-in expired before it was authorized — try again.
        </p>
      )}
    </div>
  );
}

/** Grok's black-hole G monogram (lucide has no brand icon for it). */
function GrokLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fillRule="evenodd"
        d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"
      />
    </svg>
  );
}
