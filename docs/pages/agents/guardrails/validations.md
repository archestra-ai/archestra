---
title: Validations
description: Check that the Guardrails policy still allows and refuses what you intended, after every change
order: 3
beta: "Policy syntax and behavior may change as OpenAPPA evolves."
lastUpdated: 2026-10-20
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

A validation keeps one policy decision checked over time, such as "refuse an email after the agent reads an untrusted page". Each policy change reruns every validation, so a change that quietly weakens the policy shows up as a failed row.

Open **View Validations** on **Overview**, or the **Validations** tab.

## Write a Validation

1. Open the **…** menu, click **Write a validation**, and describe the case. The agent drafts a `.appa` file.
2. Review the expected decisions, and click **Test draft** in the editor to check it.
3. Save it, or commit it to the repository when [Git sync](/docs/agents/guardrails/git-sync#validations-in-git) is on.

A file lists tool calls in order, with the decision each should get. Calls in one file share a session, and each file starts fresh. See the [OpenAPPA validation guide](https://www.openappa.com/validation) for the format. **Explain validations** in the **…** menu answers questions about it.

## Run Validations

Click **Run all** to check every saved file, or the run button on a row to check one. Every accepted policy change also runs them all. Running needs [`guardrailsPolicy:update`](/docs/reference/permissions#guardrailsPolicy:update).

Each file shows its newest result:

- **Passed:** every call got the expected decision.
- **Failed:** the row shows the line and the reason.
- **Cannot run:** a call did not get an answer, such as from a model whose key is not set or a helper that cannot be reached.

What to know:

- A run executes no tools, but asks the policy's annotators and models live, with your organization's credentials. So a run can spend model tokens.
- A run asks no person. A step that expects human review passes when the call offers it.
- A failed validation does not block or roll back a policy. Click **last run** to open the run, or **Run history** in the **…** menu to compare runs.
