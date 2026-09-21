"use client";

import Link from "next/link";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretInput } from "@/components/ui/secret-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface GithubPatOption {
  id: string;
  name: string;
}

/**
 * The personal-access-token half of {@link GithubAuthConfigFields}: pick a
 * saved token, or paste one that is saved on submit so the schedule it backs
 * stays authenticated.
 *
 * Shared rather than copied. The skills import dialog and the plugin
 * marketplace import dialog ask for the same credential in the same order, and
 * when this lived in both of them the two copies drifted into unlabelled
 * controls whose help text sat under the input instead of above it.
 */
export function GithubPatFields({
  idPrefix,
  pats,
  patId,
  onPatIdChange,
  token,
  onTokenChange,
  tokenName,
  onTokenNameChange,
  repoLabel,
  /** What the saved token keeps authenticated, e.g. "scheduled syncs". */
  purpose,
}: {
  /** Namespaces the field ids so two of these can coexist on a page. */
  idPrefix: string;
  pats: GithubPatOption[];
  /** "" means "paste a new token" rather than reuse a saved one. */
  patId: string;
  onPatIdChange: (patId: string) => void;
  token: string;
  onTokenChange: (token: string) => void;
  tokenName: string;
  onTokenNameChange: (tokenName: string) => void;
  repoLabel?: string | null;
  purpose: string;
}) {
  return (
    <div className="space-y-5">
      {pats.length > 0 && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-saved-token`}>Saved token</Label>
          <FieldDescription>
            Reuse a token from <CredentialsLink />, or paste a new one.
          </FieldDescription>
          <Select
            value={patId || "new"}
            onValueChange={(value) =>
              onPatIdChange(value === "new" ? "" : value)
            }
          >
            <SelectTrigger id={`${idPrefix}-saved-token`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pats.map((pat) => (
                <SelectItem key={pat.id} value={pat.id}>
                  {pat.name}
                </SelectItem>
              ))}
              <SelectItem value="new">New token…</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {patId ? (
        <FieldDescription>
          {purpose} stay authenticated with this saved token. Manage saved
          tokens in <CredentialsLink />.
        </FieldDescription>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-github-token`}>
              Personal access token
            </Label>
            <FieldDescription>
              Needed for private repositories. Fine-grained or classic — see{" "}
              <a
                href="https://github.com/settings/personal-access-tokens/new"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                create a token
              </a>
              . Saved to <CredentialsLink /> so {purpose} stay authenticated.
            </FieldDescription>
            <SecretInput
              id={`${idPrefix}-github-token`}
              value={token}
              onChange={(event) => onTokenChange(event.target.value)}
              placeholder="ghp_…"
            />
          </div>

          {token.trim() && (
            <div className="space-y-2">
              <Label htmlFor={`${idPrefix}-token-name`}>Token name</Label>
              <FieldDescription>
                How this token is listed in <CredentialsLink />.
              </FieldDescription>
              <Input
                id={`${idPrefix}-token-name`}
                value={tokenName}
                onChange={(event) => onTokenNameChange(event.target.value)}
                // Previews the name the token is actually saved under when
                // this is left blank, so the two never disagree. Both callers
                // derive that name the same way.
                placeholder={`${repoLabel?.split("/").filter(Boolean).pop() ?? "GitHub"} token`}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CredentialsLink() {
  return (
    <Link
      href="/settings/credentials"
      className="font-medium text-primary underline-offset-4 hover:underline"
    >
      Settings → Credentials
    </Link>
  );
}
