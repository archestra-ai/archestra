"use client";

import { Building2, ExternalLink } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useSsoProviders } from "@/lib/sso-provider.query";

export function SsoProviderSelector() {
  const { data: ssoProviders = [], isLoading } = useSsoProviders();

  const [email, setEmail] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleSsoSignIn = useCallback(
    async (providerId: string) => {
      try {
        await authClient.signIn.sso({
          providerId,
          loginHint: email,
          callbackURL: window.location.origin,
        });
      } catch (error) {
        console.error("SSO sign-in error:", error);
        toast.error("Failed to initiate SSO sign-in");
      }
    },
    [email],
  );

  const handleEmailDomainSignIn = useCallback(async () => {
    if (!email.trim()) {
      toast.error("Please enter your email address");
      return;
    }

    const domain = email.split("@")[1];
    if (!domain) {
      toast.error("Please enter a valid email address");
      return;
    }

    // Find provider by domain
    const provider = ssoProviders.find((p) => p.domain === domain);
    if (!provider) {
      toast.error(`No SSO provider configured for domain: ${domain}`);
      return;
    }

    setIsDialogOpen(false);
    await handleSsoSignIn(provider.providerId);
  }, [email, handleSsoSignIn, ssoProviders]);

  if (isLoading || ssoProviders.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">
            Or continue with SSO
          </span>
        </div>
      </div>

      <div className="space-y-2">
        {/* Show up to 3 providers directly */}
        {ssoProviders.slice(0, 3).map((provider) => (
          <Button
            key={provider.id}
            variant="outline"
            className="w-full"
            onClick={() => handleSsoSignIn(provider.providerId)}
          >
            <Building2 className="mr-2 h-4 w-4" />
            Sign in with {provider.domain}
          </Button>
        ))}

        {/* If more than 3 providers, show email domain selector */}
        {ssoProviders.length > 3 && (
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" className="w-full">
                <ExternalLink className="mr-2 h-4 w-4" />
                Sign in with your organization
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Sign in with SSO</DialogTitle>
                <DialogDescription>
                  Enter your work email to find your organization's SSO
                  provider.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="sso-email">Work Email</Label>
                  <Input
                    id="sso-email"
                    type="email"
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleEmailDomainSignIn();
                      }
                    }}
                  />
                </div>

                <Button onClick={handleEmailDomainSignIn} className="w-full">
                  Continue with SSO
                </Button>

                <Separator />

                <div className="space-y-2">
                  <p className="text-sm font-medium">
                    Available Organizations:
                  </p>
                  <div className="space-y-1">
                    {ssoProviders.map((provider) => (
                      <Button
                        key={provider.id}
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start"
                        onClick={() => {
                          setIsDialogOpen(false);
                          handleSsoSignIn(provider.providerId);
                        }}
                      >
                        <Building2 className="mr-2 h-4 w-4" />
                        {provider.domain}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </div>
  );
}
