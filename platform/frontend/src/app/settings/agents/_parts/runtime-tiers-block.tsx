import {
  AGENT_RUNTIME_TIERS,
  type AgentRuntimeTierSize,
  DEFAULT_AGENT_RUNTIME_TIERS,
} from "@archestra/shared";
import { SettingsBlock } from "@/components/settings/settings-block";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  RUNTIME_TIER_FIELD_LABELS,
  RUNTIME_TIER_FIELDS,
  type RuntimeTierDraft,
} from "./runtime-tiers-draft";

/** The default a blank field keeps, as the placeholder shows it. */
function defaultText(
  size: AgentRuntimeTierSize,
  field: (typeof RUNTIME_TIER_FIELDS)[number],
): string {
  if (field === "cpuLimit") return size.cpuLimit ?? "No limit";
  if (field === "warmPoolSize")
    return size.warmPoolSize === null
      ? "Deployment"
      : String(size.warmPoolSize);
  return size[field];
}

export function RuntimeTiersBlock({
  value,
  onChange,
  problems,
  canEdit,
}: {
  value: RuntimeTierDraft;
  onChange: (draft: RuntimeTierDraft) => void;
  problems: string[];
  canEdit: boolean;
}) {
  return (
    <SettingsBlock
      id="runtime-tiers"
      title="Runtime tiers"
      description="The CPU and memory of each size a run's container can get, and the spare containers each size keeps ready. An agent picks a size; a caller that starts a run can ask for a smaller one. A blank field keeps the default. New runs and spares use the new sizes."
      notice={
        canEdit ? undefined : (
          <span className="text-muted-foreground">
            Only administrators can change the tiers.
          </span>
        )
      }
    >
      {/* Narrow screens scroll the table sideways rather than squeeze it. */}
      <Table className="min-w-[46rem]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-14 whitespace-nowrap">Tier</TableHead>
            {RUNTIME_TIER_FIELDS.map((field) => (
              <TableHead key={field} className="whitespace-nowrap">
                {RUNTIME_TIER_FIELD_LABELS[field]}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {AGENT_RUNTIME_TIERS.map((tier) => (
            <TableRow key={tier}>
              <TableCell className="font-medium">{tier}</TableCell>
              {RUNTIME_TIER_FIELDS.map((field) => (
                <TableCell key={field}>
                  <Input
                    aria-label={`Tier ${tier} ${RUNTIME_TIER_FIELD_LABELS[field]}`}
                    disabled={!canEdit}
                    placeholder={defaultText(
                      DEFAULT_AGENT_RUNTIME_TIERS[tier],
                      field,
                    )}
                    value={value[tier][field]}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        [tier]: { ...value[tier], [field]: event.target.value },
                      })
                    }
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {problems.length > 0 && (
        <ul
          aria-label="Runtime tier problems"
          className="mt-3 space-y-1 text-sm text-destructive"
          role="alert"
        >
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Warm spares: &quot;Deployment&quot; follows
        ARCHESTRA_AGENT_RUNTIME_WARM_POOL_SIZE; L keeps none by default because
        its runs are rare and an idle spare holds its full size.
      </p>
    </SettingsBlock>
  );
}
