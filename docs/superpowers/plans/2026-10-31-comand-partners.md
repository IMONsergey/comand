# Comand partner delivery implementation plan

> Agentic workers: use scoped parallel tasks under the dispatching-parallel-agents workflow; integrate with a fresh security review and complete verification.

**Goal:** Ship isolated partner accounts, Apcosys-style UX and reproducible easy installation.
**Architecture:** One authenticated hub routes each user to its own durable SQLite workspace; OAuth and sessions carry identity. Existing owner remains intact.
**Tech Stack:** Node 24+, TypeScript, React, SQLite, MCP SDK and Playwright.
**Spec:** ../specs/2026-10-31-comand-partners-design.md

## Constraints and review focus

- Do not retry accepted jobs or alter agent execution deduplication.
- No secrets in repository, logs, screenshots or list responses.
- Russian UI; no imaginary email verification or support claims.
- Cross-user IDs and refresh grants must fail closed.
- Recovery must revoke other sessions/grants; restart must preserve correct identity.
- Installer paths with spaces and hostile shell metacharacters must not inject commands.
- Login errors and polling must not reset entered values or move focus.
- Deploy must preserve old owner devices and current work.

## Tasks

- [x] Accounts and identity: add accounts module, session persistence and isolated stores; extend HubAuth with principal(req): string|undefined and HubRuntime with storeFor(principal):HubStore. Keep existing store as legacy owner. Implement REST contracts from spec, scope OAuth through same identity, add behavior tests. Own src/hub/*, src/mcp/http.ts, src/mcp/oauth-provider.ts, src/shared/protocol.ts and account/auth test files.
- [x] Interface: inspect actual Apcosys sources, extract reusable primitives/tokens with provenance; implement auth/account flows against exact spec, refine existing dashboard/onboarding and keyboard/responsive behavior. Own web/* and tests/ui/* only; consume SessionInfo additions.
- [x] Distribution: implement reproducible release archive/checksum and installer, expose static download routes through isolated module wired by root, add shell/packaging tests and concise installation/troubleshooting docs. Own scripts/*, src/distribution.ts, docs/INSTALL.md, tests/distribution.test.ts.
- [x] Integration and infrastructure: root verifies baseline, reviews architecture, integrates routes, checks DNS/TLS/proxy, runs all checks and real-device smoke, fixes integration issues, publishes matching code/archive, deploys with backup and rollback. Root owns CLI/version/operational docs and CI.
- [x] Review: independent review of accounts, isolation and installer changes, resolve all confirmed issues. Record exact test/deployed revisions and limitations in VERIFICATION.md.

Each task writes regression tests for security/durability behavior, runs the focused suite, and reports actual outcomes. Root runs npm run verify, dependency audit and browser tests after integration, reviews screenshots and validates deployed public endpoints.
