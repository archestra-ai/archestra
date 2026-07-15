"use client";

import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { CodeBlock } from "@/components/ai-elements/code-block";
import {
  SECRET_PLACEHOLDER_TOKEN,
  SecretCopyButton,
} from "@/components/secret-copy-button";
import { Button } from "@/components/ui/button";
import type {
  TeamToken,
  useFetchTeamTokenValue,
} from "@/lib/teams/team-token.query";
import type { useFetchUserTokenValue } from "@/lib/user-token.query";

interface CurlExampleSectionProps {
  code: string;
  tokenForDisplay: string;
  isPersonalTokenSelected: boolean;
  hasAdminPermission: boolean;
  selectedTeamToken: TeamToken | null;
  fetchUserTokenMutation: ReturnType<typeof useFetchUserTokenValue>;
  fetchTeamTokenMutation: ReturnType<typeof useFetchTeamTokenValue>;
}

export function CurlExampleSection({
  code,
  tokenForDisplay,
  isPersonalTokenSelected,
  hasAdminPermission,
  selectedTeamToken,
  fetchUserTokenMutation,
  fetchTeamTokenMutation,
}: CurlExampleSectionProps) {
  const [showExposedToken, setShowExposedToken] = useState(false);
  const [isLoadingToken, setIsLoadingToken] = useState(false);
  const [exposedTokenValue, setExposedTokenValue] = useState<string | null>(
    null,
  );

  // Determine what token string to show in the code block
  const displayToken =
    showExposedToken && exposedTokenValue ? exposedTokenValue : tokenForDisplay;
  const displayCode = code.replace(tokenForDisplay, displayToken);

  const fetchToken = useCallback(async (): Promise<string | null> => {
    if (isPersonalTokenSelected) {
      const result = await fetchUserTokenMutation.mutateAsync();
      return result?.value ?? null;
    }
    if (selectedTeamToken) {
      const result = await fetchTeamTokenMutation.mutateAsync(
        selectedTeamToken.id,
      );
      return result?.value ?? null;
    }
    return null;
  }, [
    isPersonalTokenSelected,
    selectedTeamToken,
    fetchUserTokenMutation,
    fetchTeamTokenMutation,
  ]);

  const handleExposeToken = useCallback(async () => {
    if (showExposedToken) {
      setShowExposedToken(false);
      setExposedTokenValue(null);
      return;
    }

    setIsLoadingToken(true);
    try {
      const tokenValue = await fetchToken();
      if (tokenValue) {
        setExposedTokenValue(tokenValue);
        setShowExposedToken(true);
      }
    } catch {
      toast.error("Failed to fetch token");
    } finally {
      setIsLoadingToken(false);
    }
  }, [showExposedToken, fetchToken]);

  const canResolveToken =
    isPersonalTokenSelected || (hasAdminPermission && !!selectedTeamToken);

  const getSecretText = useCallback(async (): Promise<string | null> => {
    const tokenValue = exposedTokenValue ?? (await fetchToken());
    if (!tokenValue) return null;
    return code.replace(tokenForDisplay, tokenValue);
  }, [code, tokenForDisplay, exposedTokenValue, fetchToken]);

  return (
    <CodeBlock
      code={displayCode}
      language="bash"
      contentStyle={{
        fontSize: "0.75rem",
        paddingRight: "5rem",
      }}
    >
      <div className="flex gap-1 rounded-md border bg-background/95 p-1 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Button
          variant="ghost"
          size="icon"
          title={showExposedToken ? "Hide token" : "Expose token"}
          onClick={handleExposeToken}
          disabled={isLoadingToken || !canResolveToken}
        >
          {isLoadingToken ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : showExposedToken ? (
            <EyeOff className="h-4 w-4" />
          ) : (
            <Eye className="h-4 w-4" />
          )}
          <span className="sr-only">
            {showExposedToken ? "Hide token" : "Expose token"}
          </span>
        </Button>
        <SecretCopyButton
          getSecretText={canResolveToken ? getSecretText : null}
          placeholderText={code.replace(
            tokenForDisplay,
            SECRET_PLACEHOLDER_TOKEN,
          )}
        />
      </div>
    </CodeBlock>
  );
}
