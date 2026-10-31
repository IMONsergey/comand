# Security model

Comand is a single-owner remote execution service. Possession of the owner key or an OAuth grant with `comand:execute` permits commands on devices that opted into shell access. Shell commands have the agent OS account's permissions. Run it as a dedicated non-root account where practical.

- Defaults are loopback-only. Remote use requires HTTPS.
- Owner keys and device tokens are cryptographically random; device tokens are hashed at the hub.
- Pairing tokens expire after 10 minutes and are single-use.
- Browser sessions use HttpOnly cookies, CSRF tokens and Origin validation. HTTPS deployments set Secure cookies.
- Host validation limits DNS-rebinding access. No credentialed cross-origin UI API.
- MCP accepts Bearer credentials, not browser cookies. OAuth uses client/redirect/audience/scope binding and PKCE.
- File APIs resolve project/approved roots and reject traversal and symlink mutations. These checks are **not** isolation from a hostile concurrent local process.
- Queue and device-side acceptance enforce durable deduplication. Uncertain execution is never automatically retried.
- Logs and output are untrusted data, rendered as text. No injected HTML execution.
- Revocation prevents future authentication; already accepted work may continue. Stop the device process/group locally when immediate disconnection is required.
- Secrets and state must stay outside Git. Do not paste owner keys or device configs into issues, project notes or logs.

Protect `admin.token`, agent `config.json`, OAuth key/database and backups. Rotating the owner key is an administrative operation; this release binds the hub database to its initialized owner key and does not provide a transparent key-rotation workflow. Do not simply overwrite that file.

Report suspected issues privately to the repository owner. Avoid publishing credentials or live execution endpoints in a public issue.
