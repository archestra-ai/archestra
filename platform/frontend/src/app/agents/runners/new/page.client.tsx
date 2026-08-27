"use client";

import { useRouter } from "next/navigation";
import { useCreateRunner } from "@/lib/runners.query";
import { useRunnerForm } from "../_parts/runner-form";
import { RunnerWizard } from "../_parts/runner-wizard";

export default function NewRunnerPage() {
  const router = useRouter();
  const form = useRunnerForm();
  const create = useCreateRunner();

  return (
    <RunnerWizard
      title="Add a new runner"
      backHref="/agents/runners"
      backLabel="Runners"
      form={form}
      submitLabel="Create Runner"
      isSaving={create.isPending}
      onSubmit={async () => {
        const created = await create.mutateAsync(form.toBody());
        // Straight to the runner rather than back to the list: the next thing
        // anyone does with a new runner is point an agent at it.
        router.push(
          created ? `/agents/runners/${created.id}` : "/agents/runners",
        );
      }}
    />
  );
}
