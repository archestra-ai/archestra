"use client";

import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

/** What the line under the drop zone says about the key. */
export type PrivateKeyStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "fingerprint"; fingerprint: string }
  | { kind: "error"; message: string };

/**
 * A GitHub App's private key: a .pem dropped or chosen from disk. One status
 * line under it says where the key stands; a check result or error takes the
 * line's place, so nothing below moves. The key is handed up, never rendered.
 */
export function PrivateKeyDrop({
  id,
  label = "Private key",
  status,
  onKey,
}: {
  id: string;
  label?: string;
  status: PrivateKeyStatus;
  onKey: (privateKey: string) => void;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function readFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    onKey(await file.text());
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
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
        <Upload className="size-4" />
        <span>
          {fileName
            ? `${fileName} added`
            : "Drop the .pem file from the App settings, or choose it"}
        </span>
      </UnstyledButton>
      <input
        ref={fileInput}
        id={id}
        type="file"
        accept=".pem,application/x-pem-file"
        className="sr-only"
        aria-describedby={`${id}-status`}
        onChange={(event) => void readFile(event.target.files?.[0])}
      />
      <p
        id={`${id}-status`}
        className={cn(
          "min-h-4 text-xs",
          status.kind === "error"
            ? "text-destructive"
            : "text-muted-foreground",
        )}
        role={status.kind === "error" ? "alert" : undefined}
      >
        {status.kind === "checking" ? <span>Checking the key...</span> : null}
        {status.kind === "fingerprint" ? (
          <span>
            <span>Key fingerprint: </span>
            <code className="break-all">{status.fingerprint}</code>
          </span>
        ) : null}
        {status.kind === "error" ? <span>{status.message}</span> : null}
      </p>
    </div>
  );
}
