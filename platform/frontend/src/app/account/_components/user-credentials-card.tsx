"use client";

import { formatDistanceToNow } from "date-fns";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useDeleteUserCredential,
  useUpsertUserCredential,
  useUserCredentials,
} from "@/lib/user-credentials.query";

/**
 * Credentials this person has supplied for agents that act with their own
 * identity — a personal Claude token, a personal access token.
 *
 * Values are write-only by design: they can be replaced or removed, never read
 * back, and no administrator can see them.
 */
export function UserCredentialsCard() {
  const { data: credentials, isLoading } = useUserCredentials();
  const upsert = useUpsertUserCredential();
  const remove = useDeleteUserCredential();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const add = async () => {
    const trimmedKey = key.trim().toUpperCase();
    if (!trimmedKey || !value.trim()) return;
    try {
      await upsert.mutateAsync({ key: trimmedKey, value: value.trim() });
      toast.success(`${trimmedKey} saved`);
      setKey("");
      setValue("");
    } catch {
      // The mutation surfaces the reason.
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Credentials</CardTitle>
        <CardDescription>
          Values agents use when they act as you — a personal Claude token, for
          example. They are stored for you alone, and cannot be read back once
          saved.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <p className="text-muted-foreground">Loading...</p>}

        {!isLoading && (credentials?.length ?? 0) === 0 && (
          <p className="text-muted-foreground text-sm">
            Nothing saved yet. An agent that needs one will ask you for it when
            you start a runner.
          </p>
        )}

        <div className="flex flex-col gap-2">
          {credentials?.map((credential) => (
            <div
              key={credential.key}
              className="flex items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="flex flex-col min-w-0">
                <span className="font-mono text-sm truncate">
                  {credential.key}
                </span>
                <span className="text-xs text-muted-foreground">
                  Updated{" "}
                  {formatDistanceToNow(new Date(credential.updatedAt), {
                    addSuffix: true,
                  })}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate(credential.key)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end border-t pt-4">
          <div className="space-y-1.5">
            <Label htmlFor="credential-key">Name</Label>
            <Input
              id="credential-key"
              value={key}
              placeholder="CLAUDE_CODE_OAUTH_TOKEN"
              onChange={(event) => setKey(event.target.value.toUpperCase())}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="credential-value">Value</Label>
            <Input
              id="credential-value"
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <Button
            onClick={() => void add()}
            disabled={!key.trim() || !value.trim() || upsert.isPending}
          >
            <Plus className="h-4 w-4" /> Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
