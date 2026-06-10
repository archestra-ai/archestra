"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type GithubAuthMethod = "pat" | "github_app";

export interface GithubAppConfigOption {
  id: string;
  name: string;
}

interface GithubAuthConfigFieldsProps {
  authMethod: GithubAuthMethod;
  onAuthMethodChange: (authMethod: GithubAuthMethod) => void;
  githubAppConfigId: string;
  onGithubAppConfigIdChange: (githubAppConfigId: string) => void;
  githubAppConfigs: GithubAppConfigOption[];
  authLabel?: string;
  authOptional?: boolean;
  authDescription?: ReactNode;
  configuredDescription?: ReactNode;
  appConfigError?: ReactNode;
  patFields?: ReactNode;
}

export function GithubAuthConfigFields({
  authMethod,
  onAuthMethodChange,
  githubAppConfigId,
  onGithubAppConfigIdChange,
  githubAppConfigs,
  authLabel = "Authentication Method",
  authOptional = false,
  authDescription = "Use GitHub App authentication for organization-managed installs.",
  configuredDescription = "Manage GitHub App configurations in",
  appConfigError,
  patFields,
}: GithubAuthConfigFieldsProps) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="github-auth-method">
          {authLabel}
          {authOptional && (
            <span className="text-muted-foreground font-normal">
              {" "}
              (optional)
            </span>
          )}
        </Label>
        <Select value={authMethod} onValueChange={onAuthMethodChange}>
          <SelectTrigger id="github-auth-method" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pat">Personal Access Token</SelectItem>
            <SelectItem value="github_app">GitHub App</SelectItem>
          </SelectContent>
        </Select>
        {authDescription && (
          <p className="text-sm text-muted-foreground">{authDescription}</p>
        )}
      </div>

      {authMethod === "pat" && patFields}

      {authMethod === "github_app" && (
        <div className="space-y-2">
          <Label htmlFor="github-app-config">GitHub App Configuration</Label>
          {githubAppConfigs.length > 0 ? (
            <>
              <Select
                value={githubAppConfigId}
                onValueChange={onGithubAppConfigIdChange}
              >
                <SelectTrigger id="github-app-config" className="w-full">
                  <SelectValue placeholder="Select a GitHub App configuration" />
                </SelectTrigger>
                <SelectContent>
                  {githubAppConfigs.map((appConfig) => (
                    <SelectItem key={appConfig.id} value={appConfig.id}>
                      {appConfig.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">
                {configuredDescription} <GithubAppSettingsLink />.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Create one in <GithubAppSettingsLink />.
            </p>
          )}
          {appConfigError && (
            <p className="text-sm font-medium text-destructive">
              {appConfigError}
            </p>
          )}
        </div>
      )}
    </>
  );
}

function GithubAppSettingsLink() {
  return (
    <Link
      href="/settings/github"
      className="font-medium text-primary underline-offset-4 hover:underline"
    >
      Settings → GitHub
    </Link>
  );
}
