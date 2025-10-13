"use client";

import { Check, Copy, Link as LinkIcon, Loader2 } from "lucide-react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { authClient } from "@/lib/clients/auth/auth-client";

interface InviteByLinkCardProps {
  organizationId?: string;
  onInvitationCreated?: () => void;
}

export function InviteByLinkCard({
  organizationId,
  onInvitationCreated,
}: InviteByLinkCardProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [invitationLink, setInvitationLink] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  // Validate email format
  const isValidEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const handleGenerateLink = async () => {
    setIsGenerating(true);
    try {
      const { data, error } = await authClient.organization.inviteMember({
        email,
        role,
        organizationId,
      });

      if (error) {
        toast.error("Error", {
          description: error.message || "Failed to generate invitation link",
        });
        return;
      }

      if (data) {
        const link = `${window.location.origin}/accept-invitation/${data.id}`;
        setInvitationLink(link);
        toast.success("Invitation link generated", {
          description: "Share this link with the person you want to invite",
        });
        onInvitationCreated?.();
      }
    } catch (_err) {
      toast.error("Error", {
        description: "An unexpected error occurred",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopyLink = async () => {
    if (!invitationLink) return;

    try {
      await navigator.clipboard.writeText(invitationLink);
      setIsCopied(true);
      toast.success("Link copied", {
        description: "Invitation link copied to clipboard",
      });

      setTimeout(() => setIsCopied(false), 2000);
    } catch (_err) {
      toast.error("Error", {
        description: "Failed to copy link to clipboard",
      });
    }
  };

  const handleReset = () => {
    setEmail("");
    setRole("member");
    setInvitationLink("");
    setIsCopied(false);
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LinkIcon className="h-5 w-5" />
          Invite Member by Link
        </CardTitle>
        <CardDescription>
          Generate an invitation link to share with the person you want to
          invite to your organization.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!invitationLink ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="email">Email Address</Label>
              <Input
                id="email"
                type="email"
                placeholder="user@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isGenerating}
              />
              <p className="text-xs text-muted-foreground">
                The email of the person you want to invite
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="role">Role</Label>
              <Select
                value={role}
                onValueChange={(value: "member" | "admin") => setRole(value)}
                disabled={isGenerating}
              >
                <SelectTrigger id="role">
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                The role this person will have in your organization
              </p>
            </div>

            <Button
              onClick={handleGenerateLink}
              disabled={isGenerating || !isValidEmail}
              className="w-full"
            >
              {isGenerating && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Generate Invitation Link
            </Button>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <Label>Invitation Link</Label>
              <div className="flex items-center gap-2">
                <Input value={invitationLink} readOnly className="flex-1" />
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={handleCopyLink}
                >
                  {isCopied ? (
                    <Check className="h-4 w-4 text-green-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Share this link with{" "}
                <span className="font-medium">{email}</span> to invite them as a{" "}
                <span className="font-medium">{role}</span>
              </p>
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleReset}
                variant="outline"
                className="flex-1"
              >
                Create Another
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
