"use client";

import { formatDistanceToNow } from "date-fns";
import { Key, Loader2 } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ChatApiKeyResponse,
  PROVIDER_CONFIG,
} from "@/components/chat-api-key-form";
import { CopyableCode } from "@/components/copyable-code";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateVirtualApiKey } from "@/lib/chat-settings.query";

interface CreateVirtualKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentableKeys: ChatApiKeyResponse[];
  defaultExpirationSeconds: number | null;
}

export function CreateVirtualKeyDialog({
  open,
  onOpenChange,
  parentableKeys,
  defaultExpirationSeconds,
}: CreateVirtualKeyDialogProps) {
  const createMutation = useCreateVirtualApiKey();

  const [newKeyName, setNewKeyName] = useState("");
  const [selectedParentKeyId, setSelectedParentKeyId] = useState<string>("");
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [createdKeyValue, setCreatedKeyValue] = useState<string | null>(null);
  const [createdKeyExpiresAt, setCreatedKeyExpiresAt] = useState<Date | null>(
    null,
  );

  const defaultParentKeyId = parentableKeys[0]?.id ?? "";
  const prevOpenRef = useRef(open);

  // Reset form state only on open transition (false → true)
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen) {
      setCreatedKeyValue(null);
      setCreatedKeyExpiresAt(null);
      setNewKeyName("");
      setSelectedParentKeyId(defaultParentKeyId);
      setExpiresAt(computeDefaultExpiresAt(defaultExpirationSeconds));
    }
  }, [open, defaultParentKeyId, defaultExpirationSeconds]);

  const handleCreate = useCallback(async () => {
    if (!newKeyName.trim() || !selectedParentKeyId) return;
    try {
      const result = await createMutation.mutateAsync({
        chatApiKeyId: selectedParentKeyId,
        data: {
          name: newKeyName.trim(),
          expiresAt: expiresAt ?? undefined,
        },
      });
      setNewKeyName("");
      if (result?.value) {
        setCreatedKeyValue(result.value);
        setCreatedKeyExpiresAt(expiresAt);
      }
    } catch {
      // Handled by mutation
    }
  }, [newKeyName, selectedParentKeyId, expiresAt, createMutation]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {createdKeyValue
              ? "Virtual API Key Created"
              : "Create Virtual API Key"}
          </DialogTitle>
          {!createdKeyValue && (
            <DialogDescription>
              Create a virtual key linked to one of your provider API keys
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="space-y-4 py-2">
          {createdKeyValue ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Key className="h-4 w-4" />
                Copy this key now. It won&apos;t be shown again.
              </div>
              <CopyableCode value={createdKeyValue} />
              <div className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Expires:</span>{" "}
                {formatExpiration(createdKeyExpiresAt)}
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Provider API Key</Label>
                <Select
                  value={selectedParentKeyId}
                  onValueChange={setSelectedParentKeyId}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select an API key" />
                  </SelectTrigger>
                  <SelectContent>
                    {parentableKeys.map((key) => {
                      const config = PROVIDER_CONFIG[key.provider];
                      return (
                        <SelectItem key={key.id} value={key.id}>
                          <div className="flex items-center gap-2">
                            <Image
                              src={config.icon}
                              alt={config.name}
                              width={16}
                              height={16}
                              className="rounded dark:invert"
                            />
                            <span>{key.name}</span>
                            <Badge variant="outline" className="text-xs">
                              {config.name}
                            </Badge>
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="virtual-key-name">Name</Label>
                <Input
                  id="virtual-key-name"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="My virtual key"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCreate();
                    }
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label>
                  Expiration{" "}
                  <span className="text-muted-foreground font-normal">
                    ({Intl.DateTimeFormat().resolvedOptions().timeZone})
                  </span>
                </Label>
                <div className="flex items-center gap-2">
                  <DateTimePicker
                    value={expiresAt ?? undefined}
                    onChange={(date) => setExpiresAt(date ?? null)}
                    disabledDate={(date) => {
                      const today = new Date();
                      today.setHours(0, 0, 0, 0);
                      return date < today;
                    }}
                    placeholder="No expiration"
                    className="flex-1"
                  />
                  {expiresAt && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setExpiresAt(null)}
                    >
                      Never
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {expiresAt
                    ? `Expires ${formatExpiration(expiresAt)}`
                    : "Key will never expire"}
                </p>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {createdKeyValue ? "Close" : "Cancel"}
          </Button>
          {!createdKeyValue && (
            <Button
              onClick={handleCreate}
              disabled={
                !newKeyName.trim() ||
                !selectedParentKeyId ||
                createMutation.isPending
              }
            >
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Create
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Format an expiration date as a human-readable relative string.
 * e.g. "in 30 days", "in about 2 hours", "Never"
 */
function formatExpiration(date: Date | string | null): string {
  if (!date) return "Never";
  const d = typeof date === "string" ? new Date(date) : date;
  if (d <= new Date()) return "Expired";
  return formatDistanceToNow(d, { addSuffix: true });
}

/**
 * Compute default expiration date from config seconds value.
 * Returns null (never expires) when defaultSeconds is 0 or unavailable.
 */
function computeDefaultExpiresAt(defaultSeconds: number | null): Date | null {
  if (!defaultSeconds) return null;
  return new Date(Date.now() + defaultSeconds * 1000);
}
