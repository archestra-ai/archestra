"use client";

import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useFeature } from "@/lib/config/config.query";

interface GoogleDriveConfigFieldsProps {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  prefix?: string;
}

/** The default when nothing has been chosen — the pre-auth-mode behavior. */
export const DEFAULT_GDRIVE_AUTH_MODE = "service_account";

/**
 * Which identity the connector acts as. Deliberately the first thing asked,
 * because it decides both what credential is needed and how much of Drive
 * ends up indexed — and because the old connector inferred it from whether
 * the pasted credential happened to be JSON, which is not a decision anyone
 * made on purpose.
 */
export function GoogleDriveAuthFields({
  form,
  prefix = "config",
}: GoogleDriveConfigFieldsProps) {
  const oauth = useFeature("kbGoogleDriveOAuth");
  const authMode =
    (form.watch(`${prefix}.authMode`) as string | undefined) ??
    DEFAULT_GDRIVE_AUTH_MODE;
  const folderId = form.watch(`${prefix}.folderId`) as string | undefined;
  const driveIds = form.watch(`${prefix}.driveIds`) as
    | string
    | string[]
    | undefined;
  const isScoped = Boolean(folderId) || Boolean(driveIds?.length);

  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name={`${prefix}.authMode`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>How should Archestra reach Drive?</FormLabel>
            <Select
              value={(field.value as string) ?? DEFAULT_GDRIVE_AUTH_MODE}
              onValueChange={field.onChange}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="service_account_delegated">
                  Google Workspace domain (recommended)
                </SelectItem>
                <SelectItem value="oauth" disabled={!oauth?.configured}>
                  One Google account
                  {oauth?.configured ? "" : " — not configured"}
                </SelectItem>
                <SelectItem value="service_account">
                  Service account only
                </SelectItem>
              </SelectContent>
            </Select>
            <FormDescription>
              {authMode === "service_account_delegated" &&
                (isScoped
                  ? "The service account impersonates the admin below and indexes only the folder or drives named under Advanced."
                  : "The service account impersonates users across your domain: every shared drive, plus every user's My Drive. Nothing has to be shared by hand.")}
              {authMode === "oauth" &&
                (oauth?.configured
                  ? "Connect one Google account after saving. Archestra indexes exactly what that person can already see."
                  : "This deployment has no Google OAuth client. Set ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_ID and ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_SECRET to offer this mode.")}
              {authMode === "service_account" &&
                "The service account sees only what has been shared with its own email address — every folder, by hand, forever."}
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      {authMode === "service_account_delegated" && (
        <FormField
          control={form.control}
          name={`${prefix}.delegatedAdminEmail`}
          rules={{ required: "A delegated admin email is required" }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Delegated admin email</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  placeholder="admin@yourcompany.com"
                  {...field}
                  value={(field.value as string) ?? ""}
                />
              </FormControl>
              <FormDescription>
                A Workspace admin the service account impersonates. Authorize
                its client ID for domain-wide delegation in the Google Admin
                console first — Security → Access and data control → API
                controls.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      {authMode === "oauth" && oauth?.configured && (
        <p className="rounded-lg border bg-muted/40 p-3 text-[0.8rem] text-muted-foreground">
          Save the connector, then choose{" "}
          <strong>Connect Google account</strong>. Your Google OAuth client must
          list this redirect URI:{" "}
          <code className="break-all">{oauth.redirectUri}</code>
        </p>
      )}
    </div>
  );
}

export function GoogleDriveConfigFields({
  form,
  prefix = "config",
}: GoogleDriveConfigFieldsProps) {
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name={`${prefix}.driveIds`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Drive IDs (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="0ABcDeFgHiJkLmN, 0OpQrStUvWxYz"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of shared drive IDs to sync. Providing Drive
              IDs automatically enables shared-drive sync. Leave blank to sync
              files from My Drive.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.folderId`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Folder ID (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="1AbCdEfGhIjKlMnOpQrStUv"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Restrict sync to a specific folder. Find the folder ID in the
              Google Drive URL.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.fileTypes`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>File Types (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder=".pdf, .docx, .md"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Comma-separated list of file extensions to include. Leave blank to
              sync all supported file types.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name={`${prefix}.recursive`}
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Recursive Traversal</FormLabel>
              <FormDescription>
                Sync files from all nested subfolders (enabled by default).
                Without a Folder ID, all drive files are synced regardless.
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={field.value ?? true}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
    </div>
  );
}
