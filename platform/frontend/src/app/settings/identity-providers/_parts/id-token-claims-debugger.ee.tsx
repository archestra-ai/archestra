"use client";

import { Code2 } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useIdentityProviderLatestIdTokenClaims } from "@/lib/auth/identity-provider.query.ee";

interface IdTokenClaimsDebuggerProps {
  identityProviderId?: string;
}

export function IdTokenClaimsDebugger({
  identityProviderId,
}: IdTokenClaimsDebuggerProps) {
  const { data, isLoading } =
    useIdentityProviderLatestIdTokenClaims(identityProviderId);

  if (!identityProviderId) {
    return null;
  }

  const formattedClaims = data?.claims
    ? JSON.stringify(data.claims, null, 2)
    : null;

  return (
    <Accordion type="single" collapsible className="w-full">
      <AccordionItem
        value="latest-id-token-claims"
        className="!border rounded-md"
      >
        <AccordionTrigger className="px-4 py-2 hover:no-underline">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Code2 className="h-4 w-4" />
            Latest ID token claims
          </span>
        </AccordionTrigger>
        <AccordionContent className="px-4 pb-4 pt-0">
          <p className="text-xs text-muted-foreground mb-3">
            Decoded claims from your latest sign-in with this identity provider.
            The raw signed token is never shown.
          </p>

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading claims...</p>
          ) : formattedClaims ? (
            <ScrollArea className="max-h-80 rounded-md border bg-muted/40">
              <pre className="p-3 text-xs leading-relaxed whitespace-pre-wrap break-words font-mono">
                {formattedClaims}
              </pre>
            </ScrollArea>
          ) : (
            <p className="text-sm text-muted-foreground">
              No ID token claims are available for your account yet. Sign in
              with this provider, then reopen this dialog.
            </p>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
