"use client";

import { format } from "date-fns";
import { Check, Clock, X, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useRole } from "@/lib/auth.hook";
import {
  useApproveMcpServerInstallationRequest,
  useDeclineMcpServerInstallationRequest,
  useMcpServerInstallationRequest,
} from "@/lib/mcp-server-installation-request.query";

interface InstallationRequestDetailPageClientProps {
  id: string;
}

export default function InstallationRequestDetailPageClient({
  id,
}: InstallationRequestDetailPageClientProps) {
  const role = useRole();
  const isAdmin = role === "admin";
  const { data: request } = useMcpServerInstallationRequest(id);
  const approveMutation = useApproveMcpServerInstallationRequest();
  const declineMutation = useDeclineMcpServerInstallationRequest();

  const [reviewNotes, setReviewNotes] = useState("");

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return (
          <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600">
            <Clock className="mr-1 h-3 w-3" />
            Pending
          </Badge>
        );
      case "approved":
        return (
          <Badge variant="outline" className="bg-green-500/10 text-green-600">
            <Check className="mr-1 h-3 w-3" />
            Approved
          </Badge>
        );
      case "declined":
        return (
          <Badge variant="outline" className="bg-red-500/10 text-red-600">
            <X className="mr-1 h-3 w-3" />
            Declined
          </Badge>
        );
      default:
        return null;
    }
  };

  const handleApprove = async () => {
    await approveMutation.mutateAsync({
      id,
      reviewNotes: reviewNotes || undefined,
    });
  };

  const handleDecline = async () => {
    await declineMutation.mutateAsync({
      id,
      reviewNotes: reviewNotes || undefined,
    });
  };

  if (!request) {
    return <div>Loading...</div>;
  }

  const isPending = request.status === "pending";
  const isProcessing = approveMutation.isPending || declineMutation.isPending;

  return (
    <div className="w-full h-full">
      <div className="border-b border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <Button variant="ghost" size="sm" asChild className="mb-4">
            <Link href="/mcp-catalog/installation-requests">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Requests
            </Link>
          </Button>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight mb-2">
                Installation Request #{request.id.slice(0, 8)}
              </h1>
              <p className="text-sm text-muted-foreground">
                Requested on{" "}
                {format(new Date(request.createdAt), "MMM d, yyyy 'at' h:mm a")}
              </p>
            </div>
            {getStatusBadge(request.status)}
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-8">
        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Request Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Catalog ID</Label>
                <p className="text-sm font-mono">{request.catalogId}</p>
              </div>

              {request.requestNotes && (
                <div className="space-y-2">
                  <Label>Request Notes</Label>
                  <p className="text-sm text-muted-foreground">
                    {request.requestNotes}
                  </p>
                </div>
              )}

              {request.reviewedAt && (
                <>
                  <div className="space-y-2">
                    <Label>Reviewed At</Label>
                    <p className="text-sm">
                      {format(
                        new Date(request.reviewedAt),
                        "MMM d, yyyy 'at' h:mm a",
                      )}
                    </p>
                  </div>

                  {request.reviewedBy && (
                    <div className="space-y-2">
                      <Label>Reviewed By</Label>
                      <p className="text-sm font-mono">{request.reviewedBy}</p>
                    </div>
                  )}

                  {request.reviewNotes && (
                    <div className="space-y-2">
                      <Label>Review Notes</Label>
                      <p className="text-sm text-muted-foreground">
                        {request.reviewNotes}
                      </p>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {isAdmin && isPending && (
            <Card>
              <CardHeader>
                <CardTitle>Review Request</CardTitle>
                <CardDescription>
                  Approve or decline this installation request
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="review-notes">Review Notes (Optional)</Label>
                  <Textarea
                    id="review-notes"
                    placeholder="Add notes about your decision..."
                    value={reviewNotes}
                    onChange={(e) => setReviewNotes(e.target.value)}
                    rows={4}
                  />
                </div>

                <div className="flex gap-2">
                  <Button
                    onClick={handleApprove}
                    disabled={isProcessing}
                    className="flex-1"
                  >
                    <Check className="mr-2 h-4 w-4" />
                    {approveMutation.isPending ? "Approving..." : "Approve"}
                  </Button>
                  <Button
                    onClick={handleDecline}
                    disabled={isProcessing}
                    variant="destructive"
                    className="flex-1"
                  >
                    <X className="mr-2 h-4 w-4" />
                    {declineMutation.isPending ? "Declining..." : "Decline"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
