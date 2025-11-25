-- Drop optimize_cost column from agents table
ALTER TABLE "agents" DROP COLUMN "optimize_cost";

-- Drop priority column from optimization_rules table (no longer needed for compound rules)
ALTER TABLE "optimization_rules" DROP COLUMN "priority";
