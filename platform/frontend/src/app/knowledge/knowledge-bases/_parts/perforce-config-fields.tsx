"use client";

import type { ReactNode } from "react";
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
import { SecretInput } from "@/components/ui/secret-input";
import { joinIfArray } from "./transform-config-array-fields";

export function PerforceConfigFields({
  form,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
}) {
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name="config.fileTypes"
        render={({ field }) => (
          <FormItem>
            <FormLabel>File Types (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder=".md, .yaml, .yml"
                {...field}
                value={joinIfArray(field.value)}
              />
            </FormControl>
            <FormDescription>
              Comma-separated file extensions to index. Defaults to .md, .yaml,
              .yml. Binary files are always skipped, so broader lists (e.g.
              .txt, .json) are safe to add.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="config.excludePaths"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Exclude Paths (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="//depot/docs/generated, //depot/docs/vendor"
                {...field}
                value={joinIfArray(field.value)}
              />
            </FormControl>
            <FormDescription>
              Comma-separated depot paths to skip within the synced depot paths.
              Useful to carve large or irrelevant subtrees out of a broad path.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Fields permission sync needs, rendered by the create/edit dialogs only when
 * the Auto-sync permissions visibility is selected. The admin password rides
 * in the shared `adminApiKey` credential field (the same slot the Atlassian
 * connectors use for their org-admin key), so a blank value on edit keeps the
 * stored password.
 */
export function PerforcePermissionSyncFields({
  form,
  mode,
  adminCredentialDescription,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: form type is generic across different form schemas
  form: UseFormReturn<any>;
  mode: "create" | "edit";
  /**
   * What the admin account needs in Perforce. Passed in rather than read here,
   * so the per-connector requirement copy stays in one place.
   */
  adminCredentialDescription?: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">Permission sync</p>
        <p className="text-muted-foreground text-sm">
          Mirrors each document&apos;s access from Perforce, using an
          administrative account.
        </p>
      </div>
      <FormField
        control={form.control}
        name="config.adminUsername"
        rules={{ required: "Admin username is required for permission sync" }}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Admin Username</FormLabel>
            <FormControl>
              <Input
                placeholder="p4admin"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              The Perforce user permission sync authenticates as.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="adminApiKey"
        rules={
          mode === "create"
            ? { required: "Admin password is required for permission sync" }
            : undefined
        }
        render={({ field }) => (
          <FormItem>
            <FormLabel>Admin Password</FormLabel>
            <FormControl>
              <SecretInput
                placeholder={
                  mode === "create"
                    ? "Password of the Perforce admin user"
                    : "Leave empty to keep existing password"
                }
                {...field}
              />
            </FormControl>
            {/*
             * One description, never two stacked: the requirement describes the
             * account rather than the value in the box — on edit this field is
             * normally left blank, and an admin fixing privileges upstream does
             * not retype the password.
             */}
            {(mode === "edit" || adminCredentialDescription) && (
              <FormDescription>
                {mode === "edit" ? (
                  <span>Leave empty to keep the existing password.</span>
                ) : null}{" "}
                {adminCredentialDescription}
              </FormDescription>
            )}
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="config.p4Port"
        rules={{
          pattern: {
            value: /^(ssl:)?[A-Za-z0-9_.[\]-]+:\d{1,5}$/,
            message: 'P4 port must look like "host:1666" or "ssl:host:1666"',
          },
        }}
        render={({ field }) => (
          <FormItem>
            <FormLabel>P4 Port</FormLabel>
            <FormControl>
              <Input
                placeholder={p4PortPlaceholder(form.watch("config.serverUrl"))}
                {...field}
                value={(field.value as string) ?? ""}
              />
            </FormControl>
            <FormDescription>
              Leave empty unless the Perforce server's wire address is not the
              host in the Server URL.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

/**
 * Show the operator the address that will be used when the field is left
 * empty, so the derivation is visible rather than implied.
 */
function p4PortPlaceholder(serverUrl: unknown): string {
  if (typeof serverUrl === "string" && serverUrl) {
    try {
      const { hostname } = new URL(serverUrl);
      if (hostname) return `${hostname}:1666 (derived from Server URL)`;
    } catch {
      // Half-typed URL — fall through to the generic example.
    }
  }
  return "perforce.example.com:1666";
}
// SPDX-SnippetEnd
