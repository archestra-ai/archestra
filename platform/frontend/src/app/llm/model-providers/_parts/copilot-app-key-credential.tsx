"use client";

import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useCopilotGithubAppKeySummary } from "@/lib/github-copilot-app.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * The credential part of the edit dialog for an organization's GitHub Copilot
 * subscription: what the stored App is, read-only, and a private key drop to
 * replace it. The key is held for the save and never rendered.
 */
export function CopilotAppKeyCredential({
  keyId,
  onPrivateKeyChange,
}: {
  keyId: string;
  onPrivateKeyChange: (privateKey: string | null) => void;
}) {
  const { data: summary, isPending } = useCopilotGithubAppKeySummary(keyId);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function readFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    onPrivateKeyChange(await file.text());
  }

  const rows: Array<[string, string]> = summary
    ? [
        ["Organization", summary.organization ?? "Unknown"],
        ["GitHub App", summary.appName ?? `App ${summary.appId}`],
        ["Key fingerprint", summary.fingerprint],
        [
          "Models",
          `${summary.modelCount} ${summary.modelCount === 1 ? "model" : "models"}`,
        ],
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>GitHub App</Label>
        {isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-md border px-3 py-2.5 text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-all">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="copilot-app-key-replace">Replace private key</Label>
        <UnstyledButton
          className={cn(
            "flex w-full flex-col items-center gap-1 rounded-md border border-dashed px-4 py-4 text-sm text-muted-foreground",
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
              ? `${fileName} added. It replaces the key when you save.`
              : "Drop a new .pem file from the App settings, or choose it"}
          </span>
        </UnstyledButton>
        <input
          ref={fileInput}
          id="copilot-app-key-replace"
          type="file"
          accept=".pem,application/x-pem-file"
          className="sr-only"
          onChange={(event) => void readFile(event.target.files?.[0])}
        />
      </div>
    </div>
  );
}
