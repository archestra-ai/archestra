"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import {
  currentUser,
  catalogItems as seedCatalogItems,
  credentials as seedCredentials,
  environments as seedEnvironments,
  pods as seedPods,
  teams as seedTeams,
} from "./data";
import type {
  CatalogItem,
  Credential,
  Environment,
  FieldDef,
  Mapping,
  Pod,
  Team,
} from "./types";

type StoreValue = {
  catalogItems: CatalogItem[];
  environments: Environment[];
  credentials: Credential[];
  pods: Pod[];
  teams: Team[];
  currentUser: typeof currentUser;
  revokeCredential: (id: string) => void;
  installCredential: (input: Omit<Credential, "id" | "createdAt">) => void;
  upsertEnvironment: (env: Environment) => void;
  deleteEnvironment: (id: string) => void;
  restartPod: (id: string) => void;
  addField: (catalogId: string, field: FieldDef) => void;
  addMapping: (catalogId: string, mapping: Mapping) => void;
};

const StoreContext = createContext<StoreValue | null>(null);

export function SpikeStoreProvider({ children }: { children: ReactNode }) {
  const [catalogItems, setCatalogItems] =
    useState<CatalogItem[]>(seedCatalogItems);
  const [environments, setEnvironments] =
    useState<Environment[]>(seedEnvironments);
  const [credentials, setCredentials] = useState<Credential[]>(seedCredentials);
  const [pods, setPods] = useState<Pod[]>(seedPods);
  const [teams] = useState<Team[]>(seedTeams);

  const value = useMemo<StoreValue>(
    () => ({
      catalogItems,
      environments,
      credentials,
      pods,
      teams,
      currentUser,
      revokeCredential: (id) =>
        setCredentials((cs) => cs.filter((c) => c.id !== id)),
      installCredential: (input) =>
        setCredentials((cs) => [
          ...cs,
          {
            ...input,
            id: `cred-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: new Date().toISOString(),
          },
        ]),
      upsertEnvironment: (env) =>
        setEnvironments((es) => {
          const exists = es.some((e) => e.id === env.id);
          return exists
            ? es.map((e) => (e.id === env.id ? env : e))
            : [...es, env];
        }),
      deleteEnvironment: (id) => {
        setEnvironments((es) => es.filter((e) => e.id !== id));
        setCredentials((cs) => cs.filter((c) => c.environmentId !== id));
        setPods((ps) => ps.filter((p) => p.environmentId !== id));
      },
      restartPod: (id) =>
        setPods((ps) =>
          ps.map((p) =>
            p.id === id
              ? { ...p, status: "restarting", restarts: p.restarts + 1 }
              : p,
          ),
        ),
      addField: (catalogId, field) =>
        setCatalogItems((cs) =>
          cs.map((c) =>
            c.id === catalogId ? { ...c, fields: [...c.fields, field] } : c,
          ),
        ),
      addMapping: (catalogId, mapping) =>
        setCatalogItems((cs) =>
          cs.map((c) =>
            c.id === catalogId
              ? { ...c, mappings: [...c.mappings, mapping] }
              : c,
          ),
        ),
    }),
    [catalogItems, environments, credentials, pods, teams],
  );

  return (
    <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
  );
}

export function useSpikeStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("SpikeStoreProvider missing");
  return ctx;
}
