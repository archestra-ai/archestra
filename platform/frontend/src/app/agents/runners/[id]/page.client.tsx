"use client";

import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { LabelTags } from "@/components/label-tags";
import { LoadingState } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import { useEnvironments } from "@/lib/environment.query";
import { useRunner, useRunnerPreflight } from "@/lib/runners.query";
import { RunnerBackLink } from "../_parts/runner-wizard";

export default function RunnerDetailPage({ runnerId }: { runnerId: string }) {
  const router = useRouter();
  const { data: runner, isPending } = useRunner(runnerId);
  const { data: environmentList } = useEnvironments();
  // What *this* reader still has to supply before the runner can act as them.
  const { data: preflight } = useRunnerPreflight(runnerId);

  if (isPending) {
    return (
      <PageLayout
        title="Runner"
        backLink={<RunnerBackLink href="/agents/runners" label="Runners" />}
      >
        <LoadingState variant="page" />
      </PageLayout>
    );
  }

  if (!runner) {
    return (
      <PageLayout
        title="Runner not found"
        description="It may have been deleted."
        backLink={<RunnerBackLink href="/agents/runners" label="Runners" />}
      >
        <span />
      </PageLayout>
    );
  }

  const environmentName = runner.environmentId
    ? (environmentList?.environments.find(
        (env) => env.id === runner.environmentId,
      )?.name ?? "Unknown")
    : "Default";

  return (
    <PageLayout
      title={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 truncate">{runner.name}</span>
          <LabelTags labels={runner.labels} />
        </div>
      }
      description={runner.description ?? undefined}
      backLink={<RunnerBackLink href="/agents/runners" label="Runners" />}
      actionButton={
        <PermissionButton
          permissions={{ runner: ["update"] }}
          onClick={() => router.push(`/agents/runners/${runner.id}/edit`)}
        >
          <Pencil className="h-4 w-4" />
          Edit
        </PermissionButton>
      }
    >
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Container</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Image">
              <code className="break-all text-xs">{runner.image}</code>
            </Field>
            <Field label="Command">
              {runner.command?.length ? (
                <code className="break-all text-xs">
                  {runner.command.join(" ")}
                </code>
              ) : (
                <span className="text-sm text-muted-foreground">
                  The image's own entrypoint
                </span>
              )}
            </Field>
            <Field label="Backend">
              <Badge variant="outline">{runner.backend}</Badge>
            </Field>
            <Field label="Environment">
              <Badge variant="outline">{environmentName}</Badge>
            </Field>
            <Field label="Steering">
              <span className="text-sm">
                {runner.steerMode === "pipe"
                  ? "Pipe — injected at the next turn boundary"
                  : "tmux keys — typed into the session"}
              </span>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Credentials</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {runner.credentials?.length ? (
              runner.credentials.map((credential) => {
                const missing = preflight?.missing.some(
                  (entry) => entry.key === credential.key,
                );
                return (
                  <div
                    key={credential.key}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                  >
                    <div className="min-w-0">
                      <code className="text-xs">{credential.key}</code>
                      <div className="text-sm">{credential.label}</div>
                      {credential.description ? (
                        <div className="text-xs text-muted-foreground">
                          {credential.description}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">
                        {credential.scope === "per_user"
                          ? "Per user"
                          : "Shared"}
                      </Badge>
                      {credential.required ? (
                        <Badge variant="secondary">Required</Badge>
                      ) : null}
                      {/* Only ever about the reader: a colleague may well have
                          supplied theirs. */}
                      {missing ? (
                        <Badge variant="destructive">
                          You haven't set this
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="text-sm text-muted-foreground">
                None declared. Sessions on this runner get no injected
                credentials.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}
