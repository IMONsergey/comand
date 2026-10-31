# Security model

Comand is a remote execution service for trusted users and their own devices. Registered accounts have separate durable SQLite workspaces. Browser and MCP requests choose a workspace using authenticated identity, never a user-supplied tenant ID. Existing 0.1 data and grants remain with the legacy owner; registration cannot claim that workspace.

## Identity

- Passwords use asynchronous, salted scrypt; raw passwords are not stored. IP/account throttling and bounded KDF concurrency protect authentication endpoints.
- Recovery uses a cryptographically random one-time code, stored only as a hash. Email is an unverified login identifier; no email delivery is configured.
- Cookie sessions are persisted as hashes, HttpOnly, SameSite=Lax and Secure over HTTPS. Cookie mutations require same-origin CSRF checks.
- Credential versions invalidate sessions, pending OAuth codes, access and refresh tokens after password change/recovery, even if a crash interrupts explicit grant revocation.
- OAuth binds codes/grants/tokens to principal, client, resource, redirect and scope, checks PKCE and rotates refresh tokens. Old schema records migrate to legacy owner.
- The owner key is an administrative fallback for that owner's workspace, not a general impersonation token for other accounts. The host administrator can access data files and must be trusted.

## Devices and execution

- Pairing codes are single-use and expire after ten minutes. Device tokens are hashed at the hub. Concurrent pairing cannot overwrite an existing device configuration.
- Revocation prevents future authentication. Already accepted commands or interactive sessions may continue on the device; stop those processes locally if immediate termination is required.
- Shell commands have the agent OS account's permissions. Run agents as dedicated non-root accounts where practical. File roots do not sandbox shell.
- File APIs validate canonical approved roots and reject traversal/symlink mutation. They do not promise isolation from a hostile concurrent local process modifying those paths.
- Durable acceptance deduplicates jobs on the hub and device. Unknown results remain uncertain and are never automatically retried. Process-session input has durable receipt semantics; an uncertain write is not replayed automatically.
- Interactive sessions use private file IPC and are scoped to project and agent state. Process controls require shell execution permission. The guardian owns its live process group; stale saved PIDs are not used to kill unrelated processes.
- Text/output are untrusted and rendered as text. They do not become instructions or executable UI.

## Deployment

- Loopback by default; external deployments require HTTPS and an explicit public origin. Host/Origin checks and no permissive credentialed CORS.
- Only the direct loopback reverse proxy is trusted for client IP. The proxy must overwrite forwarded headers.
- Installer downloads use HTTPS, checksums and explicit packaged paths. Installer executes code with the installing user's permissions. SHA-256 protects transfer integrity; it does not protect against compromise of the trusted distribution server.
- Protect the entire hub/agent state, including admin.token, config.json, accounts.sqlite, per-account stores, OAuth keys/databases and backups. Keep them out of Git and support logs.
- Never expose a hub state folder as a static download directory. The distribution server exposes only named release files.
- Use consistent backups as described in docs/OPERATIONS.md. Database migrations are additive; a rollback must restore both code and a matching saved state if needed.

Report suspected issues privately to the repository owner. Do not publish credentials, recovery codes or command output containing secrets.
