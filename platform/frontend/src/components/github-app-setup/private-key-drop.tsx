"use client";

import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

/**
 * A GitHub App's private key: a .pem dropped on, or chosen from, an
 * input-high target. The key is handed up, never rendered.
 */
export function PrivateKeyDrop({
  id,
  describedBy,
  onKey,
}: {
  id: string;
  /** The status line that speaks for the key. */
  describedBy: string;
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
    // A grid, not space-y: the sr-only input is absolutely positioned and
    // would otherwise still take a sibling margin below the button.
    <div className="grid min-w-0 gap-2">
      <Label htmlFor={id}>Private key</Label>
      <UnstyledButton
        className={cn(
          "flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-dashed px-3 text-sm text-muted-foreground",
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
        <Upload className="size-4 shrink-0" />
        <span className="truncate">
          {fileName ?? "Choose or drop the .pem file"}
        </span>
      </UnstyledButton>
      <input
        ref={fileInput}
        id={id}
        type="file"
        accept=".pem,application/x-pem-file"
        className="sr-only"
        aria-describedby={describedBy}
        onChange={(event) => void readFile(event.target.files?.[0])}
      />
    </div>
  );
}
