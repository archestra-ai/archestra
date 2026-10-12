import type {
  PolicyBattery,
  PolicyDeclarations,
} from "@/lib/openappa-batteries.query";

export type BatteryCredential = PolicyBattery["credentials"][number];

/**
 * The credential rows a battery's dialog shows. An included battery shows what
 * its composition binds. One not included yet reads the organization's table
 * like any other: a variable an included battery composes has that battery's
 * key and source, and otherwise a stored binding fills it.
 */
export function batteryCredentials(params: {
  declarations: Pick<PolicyDeclarations, "batteries" | "credentialBindings">;
  name: string;
  /** The variables the battery's manifest reads. */
  variables: readonly string[];
}): BatteryCredential[] {
  const { declarations, name, variables } = params;
  const included = declarations.batteries.find(
    (battery) => battery.name === name,
  );
  if (included) return included.credentials;
  const composed = new Map(
    declarations.batteries.flatMap((battery) =>
      battery.credentials.map(
        (credential) => [credential.variable, credential] as const,
      ),
    ),
  );
  const stored = new Map(
    declarations.credentialBindings.map(
      (binding) => [binding.variable, binding.key] as const,
    ),
  );
  return variables.map((variable) => {
    const known = composed.get(variable);
    if (known) return known;
    const key = stored.get(variable) ?? null;
    return {
      variable,
      key,
      source: key === null ? null : "binding",
      readers: [],
    };
  });
}
