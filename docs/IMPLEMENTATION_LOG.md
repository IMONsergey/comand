# Implementation ledger

## 2026-10-31: scope and architecture

- Repository verified empty; a dedicated checkout was prepared. The user authorized implementation and publication in IMONsergey/comand.
- Independent workers owned disjoint hub, agent and UI paths; the maintainer integrated and reviewed shared contracts. No existing project work needed isolation.
- Selected a native durable execution core with a hub, outbound-poll agents and detached job supervisors. Core persistence does not depend on transient upstream MCP sessions.
- Supported runtime is Node.js 24+ on macOS and Linux. Native desktop/Figma control and an upstream Desktop Commander adapter are not implemented.

## 2026-10-31: implementation and review

- Implemented the SQLite-backed hub, authentication, projects, durable jobs, logs, cancellation and device pairing; added owner and device HTTP APIs with validation and access checks.
- Implemented agent pairing and execution, durable acceptance evidence, uncertain recovery, overlapping-root locks, bounded logs, shell timeout/cancellation, file operations and isolated browser inspection.
- Implemented the Russian web panel, project context, job details, real result/log views, pairing and connection settings.
- Implemented 17 MCP tools, Streamable HTTP and a private stdio bridge, plus persisted OAuth clients/grants, PKCE consent, refresh rotation and revocation.
- Added user launchd/systemd installation, production build, CI, Docker/Compose and reverse proxy examples, security and recovery documentation.
- Release review found and fixed executable symlink handling, missing checkout commands in setup flows, lost public deployment settings, browser-channel persistence, development proxy handling and private service diagnostics.
- Real-device recovery exposed a lost-acknowledgment log upload case. Added regression coverage and a fix for a matching replay overlap with a grown tail; conflicting replay bytes remain rejected.
- The Linux unit parser exposed a generated service-format issue; the service definition was fixed and tested with actual `systemd-analyze verify`.

## 2026-10-31: verification and deployment checkpoint

- Maintainer's latest complete local `npm run verify`: all 40 core/integration tests, both TypeScript checks and the production build passed.
- Ubuntu and macOS core CI passed. macOS skips one Linux-only systemd parser test.
- macOS: hub and paired agent installed as user launchd services. Live restarts of both during a four-second command preserved one execution and full UTF-8/Cyrillic logs; idempotency, an official MCP client with 17 tools, an actual file read and isolated JPEG browser output passed.
- Linux: hub and paired agent installed as systemd user services; both running, with user lingering enabled. Live restarts during a four-second command passed: one execution, same job on idempotent resubmission and full UTF-8 logs (62 bytes). Official MCP discovery found 17 tools and an actual file read passed. Evidence: `/tmp/comand-linux-live-verification.log` on the device; verified installed revision `9d995b1`.
- The mobile flow previously timed out; an explicit viewport CSS fix resolved the CI failure. All four desktop/mobile E2E cases and both core CI jobs passed on `adcb7ea1c9eda1504ebe8e2612ac050deb226ef0` in [run 41164324625](https://github.com/IMONsergey/comand/actions/runs/41164324625). The separate real-Mac Chrome run passed all four E2E cases against the built adcb7ea application in 39.9 seconds; evidence is `/tmp/comand-e2e-built-viewport.log`. The maintainer reviewed and saved `docs/images/comand-desktop.png` (live Mac) and `docs/images/comand-mobile.png` (390-pixel E2E fixture).
- Code is published to the user's GitHub repository. Both Mac and Linux executables were rebuilt from `adcb7ea1c9eda1504ebe8e2612ac050deb226ef0` and their hub/agent services restarted successfully; final service names and sanitized lifecycle snapshots are recorded in VERIFICATION.md. Any later commit of these notes is documentation-only and distinct from the tested executable revision.
- Both installed hubs are independent local loopback deployments. No single shared public hub has been configured.
- Public HTTPS domain/DNS and authorized root reverse proxy access were unavailable; ChatGPT account connector registration was not performed. Docker configuration exists, but its runtime was not exercised.

Detailed results and release boundaries: [VERIFICATION.md](VERIFICATION.md). All local release verification gates described here passed. Public endpoint setup, ChatGPT account registration and Docker runtime remain explicitly unverified external steps.
