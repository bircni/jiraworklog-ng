# JiraWorklog NG

## Code Quality

All changes must be free of lint and compile errors before being considered complete.

- **Lint:** `pnpm lint`
- **Type check:** `pnpm exec tsc --noEmit`
- **Unit tests:** `pnpm test:unit` (Vitest — pure logic in `src/lib`, `src/db`)
- **E2E tests:** `pnpm test:e2e` (Playwright — builds and drives the real app)

Run lint, type check, and unit tests after every change and fix any errors
before finishing using `pnpm run validate`.