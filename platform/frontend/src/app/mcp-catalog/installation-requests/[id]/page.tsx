"use client";

import {
  ArrowLeft,
  CheckCircle,
  Clock,
  Loader2,
  Send,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { use, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useRole } from "@/lib/auth.hook";
import {
  useAddMcpServerInstallationRequestNote,
  useApproveMcpServerInstallationRequest,
  useDeclineMcpServerInstallationRequest,
  useMcpServerInstallationRequest,
} from "@/lib/mcp-server-installation-request.query";

export default function InstallationRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const userRole = useRole();
  const isAdmin = userRole === "admin";

  const { data: request, isLoading } = useMcpServerInstallationRequest(id);
  const approveMutation = useApproveMcpServerInstallationRequest();
  const declineMutation = useDeclineMcpServerInstallationRequest();
  const addNoteMutation = useAddMcpServerInstallationRequestNote();

  const [adminResponse, setAdminResponse] = useState("");
  const [newNote, setNewNote] = useState("");
  const [showApprovalForm, setShowApprovalForm] = useState(false);
  const [showDeclineForm, setShowDeclineForm] = useState(false);

  const handleApprove = async () => {
    await approveMutation.mutateAsync({ id, adminResponse });
    setAdminResponse("");
    setShowApprovalForm(false);
  };

  const handleDecline = async () => {
    await declineMutation.mutateAsync({ id, adminResponse });
    setAdminResponse("");
    setShowDeclineForm(false);
  };

  const handleAddNote = async () => {
    if (!newNote.trim()) return;
    await addNoteMutation.mutateAsync({ id, content: newNote });
    setNewNote("");
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 max-w-5xl">
        <Skeleton className="h-8 w-48 mb-6" />
        <div className="grid gap-6 md:grid-cols-3">
          <div className="md:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <Skeleton className="h-6 w-3/4" />
              </CardHeader>
              <CardContent className="space-y-4">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </CardContent>
            </Card>
          </div>
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <Skeleton className="h-6 w-1/2" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-full" />
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="container mx-auto p-6 max-w-5xl">
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground">Request not found</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const statusConfig = {
    pending: {
      icon: Clock,
      color: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
      label: "Pending Review",
    },
    approved: {
      icon: CheckCircle,
      color: "bg-green-500/10 text-green-500 border-green-500/20",
      label: "Approved",
    },
    declined: {
      icon: XCircle,
      color: "bg-red-500/10 text-red-500 border-red-500/20",
      label: "Declined",
    },
  };

  const status = statusConfig[request.status as keyof typeof statusConfig];
  const StatusIcon = status.icon;
  const isPending = request.status === "pending";

  return (
    <div className="w-full h-full">
      <div className="border-b border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <div className="flex items-center gap-4 mb-2">
            <Link href="/mcp-catalog/installation-requests">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">
              Installation Request
            </h1>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground ml-14">
              Review and manage this installation request
            </p>
            <Badge variant="outline" className={status.color}>
              <StatusIcon className="h-4 w-4 mr-2" />
              {status.label}
            </Badge>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-8 py-8">
        <div className="grid gap-6 md:grid-cols-3">
          <div className="md:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Request Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {request.externalCatalogId ? (
                  <div>
                    <p className="text-sm font-medium mb-1">Catalog ID</p>
                    <p className="text-sm text-muted-foreground font-mono">
                      {request.externalCatalogId}
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm font-medium mb-1">
                      Custom Server Configuration
                    </p>
                    {request.customServerConfig && (
                      <div className="space-y-3 mt-2">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-xs font-medium text-muted-foreground mb-1">
                              Display Name
                            </p>
                            <p className="text-sm">
                              {request.customServerConfig.label}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs font-medium text-muted-foreground mb-1">
                              Technical Name
                            </p>
                            <p className="text-sm font-mono">
                              {request.customServerConfig.name}
                            </p>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-xs font-medium text-muted-foreground mb-1">
                              Server Type
                            </p>
                            <Badge variant="outline" className="text-xs">
                              {request.customServerConfig.serverType}
                            </Badge>
                          </div>
                          {request.customServerConfig.version && (
                            <div>
                              <p className="text-xs font-medium text-muted-foreground mb-1">
                                Version
                              </p>
                              <p className="text-sm font-mono">
                                {request.customServerConfig.version}
                              </p>
                            </div>
                          )}
                        </div>

                        {request.customServerConfig.type === "remote" && (
                          <>
                            {request.customServerConfig.serverUrl && (
                              <div>
                                <p className="text-xs font-medium text-muted-foreground mb-1">
                                  Server URL
                                </p>
                                <p className="text-sm font-mono break-all">
                                  {request.customServerConfig.serverUrl}
                                </p>
                              </div>
                            )}
                            {request.customServerConfig.docsUrl && (
                              <div>
                                <p className="text-xs font-medium text-muted-foreground mb-1">
                                  Documentation URL
                                </p>
                                <p className="text-sm font-mono break-all">
                                  {request.customServerConfig.docsUrl}
                                </p>
                              </div>
                            )}
                          </>
                        )}

                        {request.customServerConfig.type === "local" &&
                          request.customServerConfig.localConfig && (
                            <div className="space-y-3">
                              <div>
                                <p className="text-xs font-medium text-muted-foreground mb-1">
                                  Command
                                </p>
                                <p className="text-sm font-mono bg-muted px-2 py-1 rounded">
                                  {
                                    request.customServerConfig.localConfig
                                      .command
                                  }
                                </p>
                              </div>

                              {request.customServerConfig.localConfig.arguments
                                .length > 0 && (
                                <div>
                                  <p className="text-xs font-medium text-muted-foreground mb-1">
                                    Arguments
                                  </p>
                                  <div className="space-y-1">
                                    {request.customServerConfig.localConfig.arguments.map(
                                      (arg) => (
                                        <p
                                          key={arg}
                                          className="text-sm font-mono bg-muted px-2 py-1 rounded"
                                        >
                                          {arg}
                                        </p>
                                      ),
                                    )}
                                  </div>
                                </div>
                              )}

                              {request.customServerConfig.localConfig
                                .environment &&
                                Object.keys(
                                  request.customServerConfig.localConfig
                                    .environment,
                                ).length > 0 && (
                                  <div>
                                    <p className="text-xs font-medium text-muted-foreground mb-1">
                                      Environment Variables
                                    </p>
                                    <div className="space-y-1">
                                      {Object.entries(
                                        request.customServerConfig.localConfig
                                          .environment,
                                      ).map(([key, value]) => (
                                        <p
                                          key={key}
                                          className="text-sm font-mono bg-muted px-2 py-1 rounded"
                                        >
                                          {key}={value}
                                        </p>
                                      ))}
                                    </div>
                                  </div>
                                )}
                            </div>
                          )}
                      </div>
                    )}
                  </div>
                )}

                {request.requestReason && (
                  <div>
                    <p className="text-sm font-medium mb-1">
                      Reason for Request
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {request.requestReason}
                    </p>
                  </div>
                )}

                <div>
                  <p className="text-sm font-medium mb-1">Requested</p>
                  <p className="text-sm text-muted-foreground">
                    {new Date(request.createdAt).toLocaleString("en-US", {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>

                {request.adminResponse && (
                  <div>
                    <p className="text-sm font-medium mb-1">Admin Response</p>
                    <p className="text-sm text-muted-foreground">
                      {request.adminResponse}
                    </p>
                  </div>
                )}

                {request.reviewedAt && (
                  <div>
                    <p className="text-sm font-medium mb-1">Reviewed</p>
                    <p className="text-sm text-muted-foreground">
                      {new Date(request.reviewedAt).toLocaleString("en-US", {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {isAdmin && isPending && (
              <Card>
                <CardHeader>
                  <CardTitle>Admin Actions</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {!showApprovalForm && !showDeclineForm && (
                    <div className="flex gap-3">
                      <Button
                        onClick={() => setShowApprovalForm(true)}
                        className="flex-1"
                      >
                        <CheckCircle className="h-4 w-4 mr-2" />
                        Approve Request
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={() => setShowDeclineForm(true)}
                        className="flex-1"
                      >
                        <XCircle className="h-4 w-4 mr-2" />
                        Decline Request
                      </Button>
                    </div>
                  )}

                  {showApprovalForm && (
                    <div className="space-y-3">
                      <Textarea
                        placeholder="Optional message to the requester..."
                        value={adminResponse}
                        onChange={(e) => setAdminResponse(e.target.value)}
                        rows={3}
                      />
                      <div className="flex gap-2">
                        <Button
                          onClick={handleApprove}
                          disabled={approveMutation.isPending}
                          className="flex-1"
                        >
                          {approveMutation.isPending && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          )}
                          Confirm Approval
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => {
                            setShowApprovalForm(false);
                            setAdminResponse("");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}

                  {showDeclineForm && (
                    <div className="space-y-3">
                      <Textarea
                        placeholder="Reason for declining (optional)..."
                        value={adminResponse}
                        onChange={(e) => setAdminResponse(e.target.value)}
                        rows={3}
                      />
                      <div className="flex gap-2">
                        <Button
                          variant="destructive"
                          onClick={handleDecline}
                          disabled={declineMutation.isPending}
                          className="flex-1"
                        >
                          {declineMutation.isPending && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          )}
                          Confirm Decline
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => {
                            setShowDeclineForm(false);
                            setAdminResponse("");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle>Timeline & Notes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Textarea
                    placeholder="Add a note or comment..."
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    rows={3}
                  />
                  <Button
                    onClick={handleAddNote}
                    disabled={addNoteMutation.isPending || !newNote.trim()}
                    size="sm"
                  >
                    {addNoteMutation.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="mr-2 h-4 w-4" />
                    )}
                    Add Note
                  </Button>
                </div>

                <Separator />

                {request.notes && request.notes.length > 0 ? (
                  <div className="space-y-4">
                    {[...request.notes]
                      .sort(
                        (a, b) =>
                          new Date(b.createdAt).getTime() -
                          new Date(a.createdAt).getTime(),
                      )
                      .map((note) => (
                        <div key={note.id} className="space-y-1">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-medium">
                              {note.userName}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {new Date(note.createdAt).toLocaleString(
                                "en-US",
                                {
                                  month: "short",
                                  day: "numeric",
                                  year: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                },
                              )}
                            </p>
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {note.content}
                          </p>
                        </div>
                      ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No notes yet
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Status</CardTitle>
              </CardHeader>
              <CardContent>
                <Badge variant="outline" className={`${status.color} text-sm`}>
                  <StatusIcon className="h-4 w-4 mr-2" />
                  {status.label}
                </Badge>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div>
                  <p className="font-medium mb-1">Request ID</p>
                  <p className="text-muted-foreground font-mono text-xs break-all">
                    {request.id}
                  </p>
                </div>
                <Separator />
                <div>
                  <p className="font-medium mb-1">Notes</p>
                  <p className="text-muted-foreground">
                    {request.notes?.length || 0} total
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
