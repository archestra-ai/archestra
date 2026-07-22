---
name: access-request-intake
description: Collect a complete system-access request from the user and file it via the IT service desk. Use when someone asks to request, grant, or set up system/application access for an employee.
---

# Access request intake

File system-access requests through the Acme IT service desk's `create_access_request` tool. The ticket
is only valid when every field is present and correct, so gather all of them before submitting.

## Required fields

Collect all five:

- `employee_email` — the person who needs access
- `system` — the system or application
- `access_level` — one of `read-only`, `read-write`, `admin`
- `justification` — the business reason
- `manager_email` — the approving manager

## Protocol

1. From the user's request, fill in whatever fields you already have.
2. If any required field is missing or ambiguous, ask the user for it. Do not guess, and do not file the
   request until you have all five.
3. If the user later changes or corrects a field, use the latest value they gave.
4. Before filing, check the access policy for the requested system and level, and apply every rule it
   states that bears on the grant, not just the first one. Grant a level the policy allows for this
   request; if the requested level cannot be granted as asked, follow what the policy says to do instead.
5. Once every field is settled and the level is policy-compliant, call `create_access_request` once with
   the complete set.
6. Report the returned `ticket_id`.
