real struggle — three format-correction loops on submit_result before a correct submit

- knowledge: 4/5 — Knew the SQL and the orders schema it needed; only the submit format tripped it.
- reasoning: 3/5 — Recovered eventually but re-sent the same rejected payload before changing anything.
- instruction_following: 4/5 — Followed the task prompt throughout; submit format discipline slipped under rejection.
- env_ergonomics: 2/5 — submit_result's published schema hid the per-field types the server enforced.

Observations:
- submit_result rejected {"total":"1234"} and the agent re-sent the identical value 2x before unquoting it.
- Re-ran the same SELECT twice after the result was already in context.