Review the following pull request.

$ARGUMENTS

## Focus areas

1. **Code Quality** — Clean code, error handling, edge cases, readability
2. **Security** — Injection vulnerabilities, input sanitization, auth/authz, secrets exposure
3. **Performance** — N+1 queries, unnecessary computation, memory leaks
4. **Testing** — Adequate coverage, edge cases, test quality
5. **Project conventions** — Check CLAUDE.md for coding standards
6. **Documentation** — Evaluate whether `docs/pages/` needs to be updated based on the PR changes. Read `docs/pages/` to understand what documentation exists. Changes that warrant doc updates include: new user-facing features, new or modified configuration options, changes to deployment or setup procedures, and renamed or removed concepts. Changes that typically do NOT require doc updates: bug fixes that restore existing documented behavior, internal refactors with no user-facing impact, test-only changes, and dependency bumps. If the PR introduces user-facing changes and no corresponding `docs/pages/` files were added or modified, flag this as REQUEST_CHANGES with a comment listing which existing doc pages likely need updating (or suggesting a new page if none exist). Be specific about what documentation is missing.

## Guidelines

- Be concise. No filler praise.
- Use inline review comments for specific issues.
- If the PR is clean, approve with a one-line summary.
- Flag blocking issues as REQUEST_CHANGES. Use COMMENT for suggestions.
- Missing documentation for user-facing changes is a blocking issue (REQUEST_CHANGES).
- Group related issues.
