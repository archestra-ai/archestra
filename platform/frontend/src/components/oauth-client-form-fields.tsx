"use client";

import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// Form fields shared between the create wizard and the per-type edit dialogs.

export function parseRedirectUris(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function RedirectUrisField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="oauth-client-redirect-uris">Redirect URIs</Label>
      <FieldDescription>
        Enter the callback URL supplied by the application you are connecting.
        After sign-in, users return to that application. This server cannot
        infer its hostname or callback path. The URL must match the
        <code className="mx-1">redirect_uri</code>sent by the application. One
        per line.
      </FieldDescription>
      <Textarea
        id="oauth-client-redirect-uris"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={
          "https://your-app.example.com/oauth/callback\nhttp://localhost:8080/oauth/callback"
        }
        rows={3}
      />
    </div>
  );
}
