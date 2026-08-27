"use client";

import { useRouter } from "next/navigation";
import { LoadingState } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { useRunner, useUpdateRunner } from "@/lib/runners.query";
import { useRunnerForm } from "../../_parts/runner-form";
import { RunnerBackLink, RunnerWizard } from "../../_parts/runner-wizard";

export default function EditRunnerPage({ runnerId }: { runnerId: string }) {
  const { data: runner, isPending } = useRunner(runnerId);

  if (isPending || !runner) {
    return (
      <PageLayout
        title="Edit runner"
        backLink={<RunnerBackLink href="/agents/runners" label="Runners" />}
      >
        <LoadingState variant="page" />
      </PageLayout>
    );
  }

  // Keyed on the runner so the form's initial state is seeded once the record
  // has actually landed, rather than from an empty first render.
  return <EditRunnerForm key={runner.id} runner={runner} />;
}

function EditRunnerForm({
  runner,
}: {
  runner: NonNullable<ReturnType<typeof useRunner>["data"]>;
}) {
  const router = useRouter();
  const form = useRunnerForm(runner);
  const update = useUpdateRunner();

  return (
    <RunnerWizard
      title={`Edit ${runner.name}`}
      backHref={`/agents/runners/${runner.id}`}
      backLabel={runner.name}
      form={form}
      submitLabel="Save"
      isSaving={update.isPending}
      onSubmit={async () => {
        await update.mutateAsync({ id: runner.id, body: form.toBody() });
        router.push(`/agents/runners/${runner.id}`);
      }}
    />
  );
}
