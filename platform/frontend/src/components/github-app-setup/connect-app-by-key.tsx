"use client";

import { CircleAlert, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

export interface AppKeyFields {
  appId: string;
  privateKey: string;
}

/**
 * Connect a GitHub App that is not connected yet, by its ID and private key.
 * Checks the key first (showing GitHub's fingerprint of it), then connects.
 * The key is held for the requests and never rendered.
 */
export function ConnectAppByKey({
  fingerprint,
  checking,
  connecting,
  error,
  onCheck,
  onConnect,
  onChange,
  connectLabel = "Connect",
}: {
  /** GitHub's fingerprint of the checked key, once checked. */
  fingerprint: string | null;
  checking: boolean;
  connecting: boolean;
  error: string | null;
  onCheck: (fields: AppKeyFields) => void;
  onConnect: (fields: AppKeyFields) => void;
  /** The fields changed: an earlier check no longer holds. */
  onChange?: () => void;
  connectLabel?: string;
}) {
  const [appId, setAppId] = useState("");
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fields =
    appId.trim() && privateKey ? { appId: appId.trim(), privateKey } : null;

  async function readFile(file: File | undefined) {
    if (!file) return;
    onChange?.();
    setFileName(file.name);
    setPrivateKey(await file.text());
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="github-app-key-app-id">App ID</Label>
        <Input
          id="github-app-key-app-id"
          inputMode="numeric"
          value={appId}
          onChange={(event) => {
            onChange?.();
            setAppId(event.target.value);
          }}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="github-app-key-pem">Private key</Label>
        <UnstyledButton
          className={cn(
            "flex w-full flex-col items-center gap-1 rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground",
            dragging && "border-primary bg-muted/40",
          )}
          onClick={() => fileInput.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void readFile(event.dataTransfer.files[0]);
          }}
        >
          <Upload className="h-4 w-4" />
          <span>
            {fileName
              ? `${fileName} added`
              : "Drop the .pem file from the App settings, or choose it"}
          </span>
        </UnstyledButton>
        <input
          ref={fileInput}
          id="github-app-key-pem"
          type="file"
          accept=".pem,application/x-pem-file"
          className="sr-only"
          onChange={(event) => void readFile(event.target.files?.[0])}
        />
        {fingerprint && (
          <p className="text-sm text-muted-foreground">
            <span>Key fingerprint: </span>
            <code className="break-all">{fingerprint}</code>
          </p>
        )}
      </div>
      {error && (
        <InlineNotice variant="error">
          <CircleAlert aria-hidden />
          <InlineNoticeText>{error}</InlineNoticeText>
        </InlineNotice>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {fingerprint ? (
          <Button
            variant="outline"
            size="sm"
            disabled={!fields || connecting}
            onClick={() => fields && onConnect(fields)}
          >
            <span>{connecting ? "Connecting..." : connectLabel}</span>
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={!fields || checking}
            onClick={() => fields && onCheck(fields)}
          >
            <span>{checking ? "Checking..." : "Check App"}</span>
          </Button>
        )}
      </div>
    </div>
  );
}
