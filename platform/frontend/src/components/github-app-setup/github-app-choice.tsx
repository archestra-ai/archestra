"use client";

import { KeyRound, Plus } from "lucide-react";
import {
  ChoiceTile,
  ChoiceTiles,
  TileIcon,
} from "@/components/git/git-setup-chrome";
import { AppIconStack } from "./app-icon-stack";

/**
 * The first choice of a GitHub App setup: one of the organization's connected
 * Apps, or a new App registered on GitHub from a manifest. With
 * `onConnectByKey`, a third choice connects an App by its ID and private key.
 */
export function GithubAppChoice({
  icons,
  appName,
  canCreate,
  onUseExisting,
  onCreate,
  onConnectByKey,
  others = false,
}: {
  /** Icons of the connected Apps; their count is the offer. */
  icons: (string | null)[];
  appName: string;
  canCreate: boolean;
  onUseExisting: () => void;
  onCreate: () => void;
  onConnectByKey?: () => void;
  /** The icons leave out the App in use: count them as other Apps. */
  others?: boolean;
}) {
  return (
    <ChoiceTiles columns={onConnectByKey ? 3 : 2}>
      <ChoiceTile
        disabled={icons.length === 0}
        onClick={onUseExisting}
        visual={<AppIconStack icons={icons} />}
        title="Use an App I already have"
        body={
          others
            ? `${icons.length} other ${icons.length === 1 ? "App" : "Apps"} connected to ${appName}.`
            : `${icons.length} connected to ${appName}.`
        }
      />
      <ChoiceTile
        onClick={onCreate}
        disabled={!canCreate}
        visual={
          <TileIcon dashed>
            <Plus className="size-4 text-muted-foreground" />
          </TileIcon>
        }
        title="Create a new GitHub App"
        body={
          canCreate
            ? "A few clicks on GitHub. No keys to copy."
            : "Requires permission to create credentials."
        }
      />
      {onConnectByKey ? (
        <ChoiceTile
          onClick={onConnectByKey}
          visual={
            <TileIcon>
              <KeyRound className="size-4 text-muted-foreground" />
            </TileIcon>
          }
          title="Connect an App by its ID and private key"
          body={`For an App that isn't connected to ${appName} yet.`}
        />
      ) : null}
    </ChoiceTiles>
  );
}
