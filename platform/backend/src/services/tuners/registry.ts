import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import config from "@/config";
import { AgentModel } from "@/models";
import { openappaEnabled } from "@/openappa/service";
import type { TunerCandidate, TunerKind } from "@/types/tuner";
import { collectAppaCandidates } from "./appa-sources";
import { refreshPublishedPolicyChanges } from "./apply";
import { collectSreCandidates } from "./sre-sources-cluster";

interface TunerDefinition {
  /** The built-in agent this tuner runs, or null while it is unavailable. */
  findAgent(organizationId: string): Promise<{ id: string } | null>;
  collect(params: {
    organizationId: string;
    now: Date;
  }): Promise<TunerCandidate[]>;
  /** Settles changes this tuner published earlier, before it looks again. */
  settle(params: { organizationId: string; userId: string }): Promise<void>;
}

export const TUNERS: Record<TunerKind, TunerDefinition> = {
  sre: {
    findAgent: async (organizationId) =>
      config.sreAgent.enabled
        ? AgentModel.getBuiltInAgent(BUILT_IN_AGENT_IDS.SRE, organizationId)
        : null,
    collect: ({ now }) => collectSreCandidates(now),
    settle: async () => {},
  },
  appa: {
    findAgent: async (organizationId) =>
      openappaEnabled()
        ? AgentModel.getBuiltInAgent(
            BUILT_IN_AGENT_IDS.APPA_TUNER,
            organizationId,
          )
        : null,
    collect: collectAppaCandidates,
    settle: refreshPublishedPolicyChanges,
  },
};
