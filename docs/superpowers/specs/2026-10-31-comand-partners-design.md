# Comand: partner accounts and product delivery

Sergey authorized continuing implementation, deployment, registration, an Apcosys-style interface, agent compatibility and installation instructions. This extends the existing single-owner contract. Preserve existing owner data, device identities and accepted jobs. Routine implementation decisions are delegated to the builder.

## Decisions

Keep Node 24, TypeScript, SQLite, React and the existing durable execution protocol. New accounts have isolated stores beneath hub state; existing owner data stays in place. A principal selects its own store at the HTTP/MCP boundary. New accounts cannot see, pair into, execute on or revoke another account's resources. Browser cookies persist securely through hub restart. OAuth codes, refresh/access tokens and grants bind to that principal; old grants belong to the legacy owner. No implicit first-user takeover.

Registration accepts display name, email and password (12–128 characters), stores only a salted memory-hard hash, and provides a one-time recovery code. Email identifies the account, but is not claimed verified; there is no configured mail delivery. Login, registration and recovery have throttling, Origin checks and generic invalid-credential errors. Recovery rotates its code, revokes previous sessions and OAuth grants. Owner-token login remains for existing installations. Owner may attach an email/password to the legacy workspace with explicit authenticated claim.

REST: GET /api/session returns SessionInfo including optional user {id,name,email}, registrationEnabled. POST /api/register {name,email,password} returns session plus recoveryCode; POST /api/login accepts {email,password} or legacy {token}; POST /api/recover {email,recoveryCode,password} returns session plus replacement recoveryCode. GET /api/account returns user/session information; POST /api/account/password {currentPassword,password}; POST /api/account/claim {name,email,password} (legacy owner only). All account mutation endpoints use existing CSRF/session rules except public register/login/recover, which check Origin and rate limits. Errors {error,code}. A recovery code is shown once with a copy/save prompt, never in logs or overview.

UI: reusable Apcosys SaaS primitives/tokens adapted under Comand branding, IBM Plex Sans/Mono, neutral monochrome, restrained red accent, compact sidebar, consistent controls, accessible keyboard flows, light/dark, mobile/tablet. Registration/login/recovery/account screens plus existing real jobs/devices/projects/connect flows. No fictitious devices/results. Install flow has three plain steps: account → install/authorize device → connect MCP. Document constraints accurately. Preserve legacy owner-token entry in an advanced control.

Installation: a reproducible versioned agent archive and checksum, HTTPS installer for Mac Intel/Apple Silicon and Linux x64/arm64, user-owned Node 24 if missing, dedicated non-root state, launchd/systemd startup. No Git or source build required by partner. Existing credentials cannot be overwritten by rerunning pairing. Installer inputs must be shell-safe. Serve only explicitly packaged installer/archive paths, never state/config. Match UI commands to supported CLI options.

Testing: existing durability suite plus separate-user REST and MCP isolation, cross-user ID probes, pairing ownership, OAuth refresh/revocation/restart, signup duplicates/validation/concurrency, login/recovery/session restart/CSRF. Browser tests exercise signup, recovery-code acknowledgment, logout/login, empty state/onboarding and existing command/file flows at desktop/mobile; inspect real screenshots. Smoke installer/service on available Mac and Linux with isolated test roots, preserve live services until release passes.

Deployment: inspect actual public DNS/TLS/proxy/service state, backup application state before upgrade, publish a tested commit and matching archive, update only Comand services. Verify public endpoints and real commands on both devices. Explicitly distinguish official MCP client tests from successful account-level ChatGPT connection. Compare DC features truthfully: missing full PTY, native GUI and rich document tools cannot be claimed supported.

## Alternatives

Shared tables with tenant IDs require invasive changes to all durability queries and are easier to get wrong here. Separate full processes per partner complicate deployment. Separate SQLite stores behind one authenticated hub keep the tested job core and give structural data separation; this is the chosen builder decision. No shared team devices/roles until explicitly designed.

## Installation simplification requested during delivery

The device dialog immediately presents one copyable command. Hostname and private agent state use local defaults; the installer creates only `~/Comand` when no custom root is specified. Optional paths and permission switches stay in Advanced. Shell access is explicitly described beside the command. The UI polls an authenticated, account-scoped pairing receipt and only reports success after that exact device polls online. It never guesses completion from a device name or an unrelated enrollment.
