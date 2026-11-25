"use client";

import type { ComponentProps, ReactNode } from "react";
import { CompanyConnectionPickers } from "@/components/claude-connection-pickers";
import { noCompanyConnection } from "@/components/claude-connection-pickers.utils";

/**
 * Who decides the company option's connection and model here: a runtime's
 * settings for every agent on it, or an agent's settings for every person
 * who runs it. The level below picks what this one leaves empty.
 */
export type CompanyAccountLevel = "runtime" | "agent";

/** What the two fields hold after a change. An absent part was left empty. */
export type CompanyAccountChange = { llmApiKeyId?: string; modelId?: string };

type Pickers = ComponentProps<typeof CompanyConnectionPickers>;

/**
 * The company option's connection and model at one level, and the line that
 * says what they amount to for the level below. Both fields are optional:
 * what is set is fixed for everyone below, what is left empty is theirs to
 * pick. A runtime's settings and an agent's settings show these same fields,
 * so the two cannot behave differently; only the sentences name another
 * level.
 */
export function CompanyAccountFields({
  level,
  fixedAbove = null,
  between,
  amongSeveral = false,
  line,
  onChange,
  ...pickers
}: Omit<
  Pickers,
  "onApiKeyChange" | "onApiKeyClear" | "onModelChange" | "onModelClear"
> & {
  level: CompanyAccountLevel;
  /**
   * What a level above already fixes, shown here in disabled fields: its
   * connection, or its connection and model. The line then speaks only of
   * what is left to this level.
   */
  fixedAbove?: "connection" | "both" | null;
  /** Shown under the fields, before the line: an error, or a lock's note. */
  between?: ReactNode;
  /**
   * The connection is one of several each person picks from, so the line
   * speaks of the runs on this one.
   */
  amongSeveral?: boolean;
  /**
   * What the fields amount to, where it is not what they say: what runs on
   * an agent read as it was saved before people could choose its account.
   */
  line?: string | null;
  onChange: (next: CompanyAccountChange) => void;
}) {
  const { apiKeyId, modelId, connectionFixed } = pickers;
  const connection = apiKeyId ?? undefined;
  const text = amongSeveral ? AMONG_SEVERAL[level] : SENTENCES[level];
  // The connection is not this level's to set: a plan's own card, or one a
  // level above fixes. Only the model is spoken of.
  const modelAlone = connectionFixed || fixedAbove === "connection";
  // With no company connection to pick yet, the fields say so and offer to
  // add one: what picking would mean waits until there is one.
  const empty =
    !pickers.compact &&
    noCompanyConnection({
      keys: pickers.keys,
      apiKeyId: apiKeyId ?? null,
      runsOn: pickers.runsOn,
      sharedOnly: pickers.sharedOnly,
      connectionFixed,
      lockedConnection: pickers.lockedConnection,
    });
  return (
    <>
      <CompanyConnectionPickers
        {...pickers}
        // A new connection has its own models: the old one's does not stay.
        onApiKeyChange={(keyId) => onChange({ llmApiKeyId: keyId })}
        onApiKeyClear={() => onChange({})}
        onModelChange={(next) =>
          onChange({ llmApiKeyId: connection, modelId: next })
        }
        onModelClear={() => onChange({ llmApiKeyId: connection })}
      />
      {between}
      {fixedAbove !== "both" && !empty && (
        <p className="text-xs text-muted-foreground">
          {line ??
            (modelAlone
              ? modelId
                ? text.model
                : text.modelOpen
              : !apiKeyId
                ? text.open
                : !modelId
                  ? text.connection
                  : text.both)}
        </p>
      )}
    </>
  );
}

// ===

type Sentences = {
  open: string;
  connection: string;
  both: string;
  modelOpen: string;
  model: string;
};

/** For a plan's card where several plans are open: only its model is set. */
const AMONG_SEVERAL: Record<CompanyAccountLevel, Sentences> = {
  runtime: {
    open: "",
    connection: "",
    both: "",
    modelOpen:
      "Optional. Leave the model empty to set it in each agent's settings.",
    model: "Every agent on this runtime uses this model on this plan.",
  },
  agent: {
    open: "",
    connection: "",
    both: "",
    modelOpen: "Each person who picks this plan picks their model.",
    model: "Every run on this plan uses this model.",
  },
};

const SENTENCES: Record<CompanyAccountLevel, Sentences> = {
  runtime: {
    open: "Optional. Set a connection and model to fix them for every agent on this runtime. Leave them empty to set them in each agent's settings.",
    connection:
      "Every agent on this runtime uses this connection. Set the model in each agent's settings, or set it here.",
    both: "Every agent on this runtime uses this connection and model.",
    modelOpen:
      "Optional. Leave the model empty to set it in each agent's settings.",
    model: "Every agent on this runtime uses this model.",
  },
  agent: {
    open: "Optional. Set a connection and model to fix them for every run on the company account. Leave them empty and each person picks their own on the agent's page.",
    connection:
      "Every run uses this connection. Each person picks their model on the agent's page, unless you set one here.",
    both: "Every run uses this connection and model.",
    modelOpen:
      "Each person picks their model on the agent's page, unless you set one here.",
    model: "Every run uses this model.",
  },
};
