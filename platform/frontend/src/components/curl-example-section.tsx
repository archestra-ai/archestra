"use client";

import { Check, Copy, Eye, EyeOff, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { TeamToken, useFetchTeamTokenValue } from "@/lib/team-token.query";
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
  const [copied, setCopied] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
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

  const handleCopyCode = useCallback(async () => {
    setIsCopying(true);
    try {
      let tokenValue = tokenForDisplay;

      if (isPersonalTokenSelected || hasAdminPermission) {
        const fetched = await fetchToken();
        if (fetched) {
          tokenValue = fetched;
        }
      }

      const codeWithRealToken = code.replace(tokenForDisplay, tokenValue);
      await navigator.clipboard.writeText(codeWithRealToken);
      setCopied(true);
      toast.success("Code copied with token");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy code");
    } finally {
      setIsCopying(false);
    }
  }, [
    code,
    tokenForDisplay,
    isPersonalTokenSelected,
    hasAdminPermission,
    fetchToken,
  ]);

  return (
    <div className="bg-muted rounded-md p-3 pt-12 relative">
      <pre className="text-xs whitespace-pre-wrap break-all overflow-x-auto">
        <code>{displayCode}</code>
      </pre>
      <div className="absolute top-2 right-2 flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2"
          onClick={handleExposeToken}
          disabled={
            isLoadingToken || (!isPersonalTokenSelected && !hasAdminPermission)
          }
        >
          {isLoadingToken ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading...</span>
            </>
          ) : showExposedToken ? (
            <>
              <EyeOff className="h-4 w-4" />
              <span>Hide token</span>
            </>
          ) : (
            <>
              <Eye className="h-4 w-4" />
              <span>Expose token</span>
            </>
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2"
          onClick={handleCopyCode}
          disabled={isCopying}
        >
          {isCopying ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Copying...</span>
            </>
          ) : copied ? (
            <>
              <Check className="h-4 w-4 text-green-500" />
              <span>Copied!</span>
            </>
          ) : (
            <>
              <Copy className="h-4 w-4" />
              <span>Copy with exposed token</span>
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
