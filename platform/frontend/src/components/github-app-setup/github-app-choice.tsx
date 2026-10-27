"use client";

import { Plus } from "lucide-react";
import { ChoiceTile } from "@/components/git/git-setup-chrome";
import { AppIconStack } from "./app-icon-stack";

/**
 * The first choice of a GitHub App setup: one of the organization's connected
 * Apps, or a new App registered on GitHub from a manifest.
 */
export function GithubAppChoice({
  icons,
  appName,
  canCreate,
  onUseExisting,
  onCreate,
}: {
  /** Icons of the connected Apps; their count is the offer. */
  icons: (string | null)[];
  appName: string;
  canCreate: boolean;
  onUseExisting: () => void;
  onCreate: () => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <ChoiceTile
        disabled={icons.length === 0}
        onClick={onUseExisting}
        visual={<AppIconStack icons={icons} />}
        title="Use an App I already have"
        body={`${icons.length} connected to ${appName}.`}
      />
      <ChoiceTile
        onClick={onCreate}
        disabled={!canCreate}
        visual={
          <span className="flex size-9 items-center justify-center rounded-lg border border-dashed">
            <Plus className="size-4 text-muted-foreground" />
          </span>
        }
        title="Create a new GitHub App"
        body={
          canCreate
            ? "A few clicks on GitHub. No keys to copy."
            : "Requires permission to create credentials."
        }
      />
    </div>
  );
}
