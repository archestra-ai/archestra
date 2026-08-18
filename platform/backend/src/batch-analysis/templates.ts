import type { BatchAnalysisColumn } from "@/types/batch-analysis";

export interface BatchAnalysisTemplate {
  /** Stable identifier; referenced by nothing persistent — columns are copied. */
  id: string;
  name: string;
  description: string;
  columns: BatchAnalysisColumn[];
}

/**
 * Predefined column sets for common contract-review shapes. Static constants
 * rather than DB rows on purpose: they carry no tenancy, applying one only
 * copies its columns into the analysis (which then owns them outright), and
 * shipping improvements is a code change with review rather than a data
 * migration. The engine itself stays horizontal — nothing here leaks into the
 * column schema.
 *
 * @public — consumed by the templates route and validated in tests
 */
export const BATCH_ANALYSIS_TEMPLATES: BatchAnalysisTemplate[] = [
  {
    id: "nda-review",
    name: "NDA review",
    description:
      "Confidentiality scope, duration, and carve-outs across a set of NDAs.",
    columns: [
      column("direction", "Direction", "text", "Is this a mutual or one-way non-disclosure agreement? Name which party discloses and which receives if one-way."),
      column("parties", "Parties", "list", "List the named parties to the agreement."),
      column("effective_date", "Effective date", "date", "What is the effective date of the agreement?"),
      column("term_years", "Confidentiality term (years)", "number", "For how many years does the confidentiality obligation last after disclosure or termination? Answer with the number of years."),
      flagged("carve_outs", "Standard carve-outs", "boolean", "Does the agreement contain the standard carve-outs (information that is public, already known, independently developed, or rightfully received from a third party)?"),
      flagged("residuals", "Residuals clause", "boolean", "Does the agreement permit use of residual knowledge retained in unaided memory?"),
      column("permitted_disclosures", "Permitted disclosures", "list", "To whom may confidential information be disclosed (affiliates, advisers, courts under order, and so on)?"),
      column("governing_law", "Governing law", "text", "Which jurisdiction's law governs the agreement?"),
      flagged("injunctive_relief", "Injunctive relief", "boolean", "May the disclosing party seek injunctive or equitable relief for a breach?"),
    ],
  },
  {
    id: "services-agreement-review",
    name: "Services agreement review",
    description:
      "Commercial terms, liability, and exit rights across service or consulting agreements.",
    columns: [
      column("parties", "Parties", "list", "List the named parties and their roles (customer, provider)."),
      column("effective_date", "Effective date", "date", "What is the effective date of the agreement?"),
      column("contract_value", "Contract value", "number", "What is the total contract value or annual fee, as a number in the contract currency? Use N/A if no amount is stated."),
      column("payment_terms", "Payment terms", "text", "What are the payment terms (net days, due on receipt, milestones)?"),
      flagged("termination_notice_days", "Termination notice (days)", "number", "How many days' written notice are required to terminate for convenience?"),
      flagged("auto_renewal", "Auto-renewal", "boolean", "Does the agreement renew automatically absent notice of non-renewal?"),
      flagged("liability_cap", "Liability cap", "text", "What is the limitation-of-liability cap, and what carve-outs pierce it?"),
      flagged("indemnities", "Indemnities", "list", "List the indemnities each party gives (IP infringement, breach of confidentiality, and so on)."),
      column("ip_ownership", "IP ownership", "text", "Who owns intellectual property created under the agreement (work product, background IP)?"),
      flagged("exclusivity", "Exclusivity", "boolean", "Does the agreement grant either party exclusivity or non-compete protection?"),
      column("governing_law", "Governing law", "text", "Which jurisdiction's law governs the agreement?"),
      column("termination_clause", "Termination clause", "exact_quote", "Quote the termination-for-convenience sentence verbatim."),
    ],
  },
  {
    id: "commercial-lease-review",
    name: "Commercial lease review",
    description:
      "Rent, term, and tenant obligations across a portfolio of leases.",
    columns: [
      column("parties", "Landlord and tenant", "list", "Name the landlord and the tenant."),
      column("premises", "Premises", "text", "Describe the leased premises (address or unit identifier)."),
      column("commencement_date", "Commencement date", "date", "On what date does the lease term commence?"),
      column("term_months", "Term (months)", "number", "How long is the initial lease term, in months?"),
      column("base_rent", "Base rent", "text", "What is the base rent and its payment frequency?"),
      flagged("rent_escalation", "Rent escalation", "text", "How does the rent escalate over the term (fixed uplift, index-linked, market review)?"),
      flagged("break_option", "Break option", "boolean", "Does the tenant have a break option before the end of the term?"),
      flagged("repair_obligation", "Repair obligation", "text", "What repair and maintenance obligations does the tenant carry (full repairing, interior only)?"),
      column("assignment_rights", "Assignment and subletting", "text", "May the tenant assign or sublet, and with what consent standard?"),
      column("governing_law", "Governing law", "text", "Which jurisdiction's law governs the lease?"),
    ],
  },
  {
    id: "employment-agreement-review",
    name: "Employment agreement review",
    description:
      "Compensation, restrictive covenants, and exit terms across employment contracts.",
    columns: [
      column("employee", "Employee", "text", "Name the employee and their role or title."),
      column("start_date", "Start date", "date", "What is the employment start date?"),
      column("base_salary", "Base salary", "number", "What is the annual base salary, as a number in the contract currency?"),
      column("bonus", "Bonus arrangements", "text", "Describe any bonus, commission, or equity arrangements."),
      flagged("notice_period_days", "Notice period (days)", "number", "How many days' notice must each side give to end the employment? Use the employee's notice if they differ."),
      flagged("non_compete", "Non-compete", "text", "Is there a post-termination non-compete, and how long and broad is it?"),
      flagged("non_solicit", "Non-solicitation", "boolean", "Is there a post-termination non-solicitation of customers or employees?"),
      column("ip_assignment", "IP assignment", "boolean", "Does the employee assign inventions and work product to the employer?"),
      flagged("garden_leave", "Garden leave", "boolean", "May the employer place the employee on garden leave during notice?"),
      column("governing_law", "Governing law", "text", "Which jurisdiction's law governs the agreement?"),
    ],
  },
  {
    id: "share-purchase-diligence",
    name: "Share purchase diligence",
    description:
      "Price, conditions, and seller protections across SPAs and acquisition documents.",
    columns: [
      column("parties", "Parties", "list", "Name the buyer(s) and seller(s)."),
      column("target", "Target", "text", "What company or business is being acquired?"),
      column("purchase_price", "Purchase price", "text", "What is the purchase price and its structure (cash, shares, earn-out)?"),
      column("signing_date", "Signing date", "date", "On what date was the agreement signed?"),
      flagged("conditions", "Conditions to closing", "list", "List the conditions precedent to closing (regulatory approvals, consents, financing)."),
      flagged("mac_clause", "Material adverse change", "boolean", "Is there a material-adverse-change condition or termination right?"),
      flagged("warranty_cap", "Warranty cap", "text", "What is the cap on the seller's liability for warranty claims?"),
      column("warranty_survival", "Warranty survival", "text", "How long do the warranties survive closing?"),
      flagged("non_compete", "Seller non-compete", "text", "Is the seller bound by a post-closing non-compete, and for how long?"),
      column("escrow", "Escrow or holdback", "text", "Is any part of the price held in escrow or held back, and on what terms?"),
      column("governing_law", "Governing law", "text", "Which jurisdiction's law governs the agreement?"),
    ],
  },
  {
    id: "credit-agreement-review",
    name: "Credit agreement review",
    description:
      "Facilities, pricing, and covenants across loan and credit documents.",
    columns: [
      column("parties", "Parties", "list", "Name the borrower(s), lender(s), and any agent."),
      column("facility_amount", "Facility amount", "text", "What is the total facility amount and currency?"),
      column("facility_type", "Facility type", "text", "What kind of facility is it (term loan, revolver, bridge)?"),
      column("maturity_date", "Maturity date", "date", "When does the facility mature?"),
      column("interest_rate", "Interest rate", "text", "How is interest calculated (reference rate plus margin)?"),
      flagged("financial_covenants", "Financial covenants", "list", "List the financial covenants (leverage, interest cover, minimum liquidity) and their levels."),
      flagged("security", "Security", "text", "What security or guarantees secure the facility?"),
      flagged("change_of_control", "Change of control", "boolean", "Does a change of control trigger mandatory prepayment or default?"),
      column("prepayment", "Voluntary prepayment", "text", "May the borrower prepay voluntarily, and with what notice or premium?"),
      column("governing_law", "Governing law", "text", "Which jurisdiction's law governs the agreement?"),
    ],
  },
  {
    id: "settlement-agreement-review",
    name: "Settlement agreement review",
    description:
      "Payments, releases, and confidentiality across settlement agreements.",
    columns: [
      column("parties", "Parties", "list", "Name the settling parties."),
      column("dispute", "Underlying dispute", "text", "What dispute or claim does the agreement settle?"),
      column("settlement_amount", "Settlement amount", "number", "What amount is paid in settlement, as a number in the contract currency? Use N/A if none."),
      column("payment_deadline", "Payment deadline", "date", "By what date must the settlement amount be paid?"),
      flagged("release_scope", "Release scope", "text", "How broad is the release (known claims only, or all claims known and unknown)?"),
      flagged("admission", "Admission of liability", "boolean", "Does any party admit liability?"),
      flagged("confidentiality", "Confidentiality", "boolean", "Are the settlement terms confidential?"),
      column("governing_law", "Governing law", "text", "Which jurisdiction's law governs the agreement?"),
    ],
  },
  {
    id: "data-protection-review",
    name: "Data protection review",
    description:
      "Processing scope, safeguards, and breach duties across DPAs and privacy addenda.",
    columns: [
      column("parties", "Controller and processor", "list", "Name the controller and the processor (or the parties' data-protection roles)."),
      column("processing_purpose", "Processing purpose", "text", "For what purposes may personal data be processed?"),
      column("data_categories", "Data categories", "list", "What categories of personal data are processed?"),
      flagged("subprocessors", "Sub-processors", "text", "May the processor engage sub-processors, and under what consent or notice regime?"),
      flagged("international_transfers", "International transfers", "text", "Are transfers outside the originating jurisdiction permitted, and under what safeguards?"),
      flagged("breach_notice_hours", "Breach notice (hours)", "number", "Within how many hours must the processor notify a personal-data breach? Answer with the number of hours."),
      column("deletion", "Deletion on termination", "text", "What must happen to personal data when the agreement ends?"),
      flagged("audit_rights", "Audit rights", "boolean", "Does the controller have the right to audit the processor's compliance?"),
      column("governing_law", "Governing law", "text", "Which jurisdiction's law governs the agreement?"),
    ],
  },
];

// ===== Internal =====

function column(
  key: string,
  name: string,
  format: BatchAnalysisColumn["format"],
  prompt: string,
): BatchAnalysisColumn {
  return { key, name, format, prompt };
}

function flagged(
  key: string,
  name: string,
  format: BatchAnalysisColumn["format"],
  prompt: string,
): BatchAnalysisColumn {
  return { key, name, format, prompt, flag: true };
}
