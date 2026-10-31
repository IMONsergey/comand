# Comand 0.1.0 verification record

Date: 2026-10-31. This record documents the completed local release checks and identifies external integrations that were not configured. Runtime observations below were reported by the maintainer operating the real devices; they are separate from the automated test suite. No credentials or device tokens are included.

## Current release status

The hub, agent, CLI, web panel and MCP/OAuth implementation are published. The current local `npm run verify` passes type checking, all **40 core/integration tests**, and the production build. Ubuntu and macOS core CI jobs have passed; macOS skips one test that invokes the Linux systemd unit parser.

Real macOS and Linux installations are running. Each currently has its own independent loopback hub and local paired agent. They do not yet form one shared public control plane. A public HTTPS deployment and an actual ChatGPT account connection are not verified.

**The complete browser suite passed in CI after the explicit mobile viewport CSS fix:** all four desktop/mobile E2E cases passed on `adcb7ea1c9eda1504ebe8e2612ac050deb226ef0`. Ubuntu core, macOS core and browser jobs all succeeded in [CI run 41164324625](https://github.com/IMONsergey/comand/actions/runs/41164324625). The separate real-Mac Chrome run also passed all four E2E cases in 39.9 seconds against the built application; its device-local log is `/tmp/comand-e2e-built-viewport.log`. The maintainer reviewed and saved the final desktop and mobile screenshots.

## Automated verification

| Check                          | Recorded result                                          | Evidence / boundary                                                                                                                 |
| ------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify`               | Passed locally: 40 tests, typecheck and production build | Maintainer's latest complete local run. Script runs `check`, `test`, then `build`.                                                  |
| Ubuntu core CI                 | Passed                                                   | `.github/workflows/ci.yml`, `core` job on `ubuntu-latest`.                                                                          |
| macOS core CI                  | Passed, one Linux-only skip                              | The skipped test uses actual `systemd-analyze verify`; see `tests/service.test.ts`. This is not a claim that systemd runs on macOS. |
| Desktop browser E2E            | Passed in final CI run                                   | Passed on adcb7ea in CI and the real-Mac Chrome run.                                                                                |
| Mobile browser E2E             | Passed in final CI run                                   | Previous timeout resolved; the fixed flow passed in CI and real-Mac Chrome on adcb7ea.                                              |
| Complete `npm run test:e2e`    | **Passed: all 4 cases in CI and on Mac**                 | Both cases passed in desktop and mobile projects in CI run 41164324625 and actual Mac Chrome (39.9 s).                              |
| Dependency audit               | CI core jobs passed, including their audit step          | Each core job runs `npm audit --audit-level=high`. No assertion that every possible vulnerability class has been audited.           |
| Docker image / Compose runtime | Not exercised                                            | Dockerfile, Compose, Caddy and Nginx examples exist; configuration review is not a successful container deployment.                 |

The core suite uses real SQLite databases, loopback HTTP servers, temporary directories and child processes. It covers owner/device authentication, CSRF, idempotency conflicts, cross-device isolation, durable dispatch and cancellation, project overlap locks, file traversal and symlink rejection, conditional writes, command timeout/cancellation, uncertain recovery, log byte cursors and UTF-8 boundaries. Regression coverage also includes a lost log acknowledgment followed by a grown overlapping upload, CLI symlink invocation, persisted public configuration and private service diagnostics. MCP/OAuth tests use the official MCP client and exercise consent, PKCE, client/resource/scope binding, refresh rotation and replay rejection. See `tests/*.test.ts` for the individual behaviors.

The browser suite is defined in `tests/ui/app.spec.ts` and `playwright.config.ts`. It exercises the real login/project/job/file/pairing/navigation flow and an isolated browser inspection that returns a JPEG. Passing lower-level browser or MCP tests does not replace the responsive UI flow.

## Real-device checks

### macOS

The maintainer installed a hub and paired agent as user launchd services. Both built executables were updated to `adcb7ea1c9eda1504ebe8e2612ac050deb226ef0` and restarted. At the final check, `world.imon.comand.hub.def56a6a` was running with PID `23678`, and `world.imon.comand.agent.17849ca5` was running with PID `23688`; both had last exit code `0`. The local hub address is `http://127.0.0.1:4310`. The following live checks passed:

- A real command continued while both hub and agent services restarted during its four-second execution.
- The command executed once; submitting its idempotency key again preserved the existing job rather than creating another execution.
- Full UTF-8/Cyrillic logs were recovered after the restarts.
- The official MCP client discovered 17 tools and completed an actual file read.
- Isolated browser inspection returned an actual JPEG screenshot.

These checks demonstrate local service execution and the tested recovery path. The browser was an isolated automation profile, not the owner's personal browser session. They do not establish a ChatGPT account connection or public HTTPS reachability.

### Linux host

The maintainer installed the repository and built it under `$HOME/Projects/comand`. A hub and paired agent are installed as systemd user services and both are running. User lingering is enabled (`Linger=yes`). The user bus is available using `XDG_RUNTIME_DIR=/run/user/1000` and `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus`.

The live restart check passed. Both services restarted while a four-second command ran; the job succeeded and the execution marker appeared exactly once. Reusing its idempotency key returned the same job. Both UTF-8 log segments were recovered (62 bytes in total). An official MCP client discovered 17 tools and completed an actual file read. The device-local evidence log is `/tmp/comand-linux-live-verification.log`.

The live recovery proof was collected on revision `9d995b1`. Both installed executables were subsequently rebuilt from `adcb7ea1c9eda1504ebe8e2612ac050deb226ef0` and restarted. At the final check, `comand-hub-a2bafb55.service` was running with PID `106644`, and `comand-agent-47ee7d85.service` was running with PID `106663`; both had last exit code `0` and restart count `0`. The local hub address is `http://127.0.0.1:4310`.

The tested executable revision on both computers is `adcb7ea1c9eda1504ebe8e2612ac050deb226ef0`. Later publication of these verification notes is a documentation-only change; it does not identify a different tested executable. PIDs and lifecycle values above are observations at verification time.

## External integration boundaries

| Integration                                  | Status                      | Remaining work                                                                                                                                                                    |
| -------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local loopback hub and local agent           | Running on macOS and Linux  | Both rebuilt/restarted from adcb7ea; real restart recovery passed on both platforms.                                                                                              |
| One shared public hub serving both computers | Not deployed                | Select a public hostname, configure DNS and TLS/reverse proxy with authorized administration access, then explicitly pair devices to that hub.                                    |
| Public HTTPS endpoint                        | Unavailable in this session | No configured public domain/DNS or authorized root proxy access was available. Existing sites, DNS and proxy configuration were not changed.                                      |
| ChatGPT account registration                 | Not performed               | Register the reachable MCP endpoint in the target account, complete OAuth and verify actual tool use there. Account/workspace eligibility is separate from server implementation. |
| Private stdio MCP bridge                     | Implemented                 | A working MCP server/client check does not establish any particular client's tunnel or account configuration.                                                                     |
| Docker runtime deployment                    | Not verified                | Build and run the image/Compose setup in a suitable authorized environment before claiming container readiness.                                                                   |

OAuth consent and token exchange were tested with an MCP client in the authored suite. These protocol checks do not assert that ChatGPT has accepted or registered this server. Native desktop control, a Figma editor and an upstream Desktop Commander adapter are outside this release's implemented scope.

## Final handoff checklist

- [x] Record the tested source SHA and deployed executable revision on each device: adcb7ea1c9eda1504ebe8e2612ac050deb226ef0.
- [x] Record final launchd/systemd service names and sanitized running states above.
- [x] Confirm the Linux live restart result: passed, with device-local evidence recorded above.
- [x] Confirm the final desktop/mobile E2E result after the mobile viewport fix: all four cases passed in CI run 41164324625 on adcb7ea.
- [x] Record the separate real-Mac Chrome run: all four E2E cases passed in 39.9 seconds, `/tmp/comand-e2e-built-viewport.log`.
- [x] Review and save the final [desktop](images/comand-desktop.png) and [mobile](images/comand-mobile.png) screenshots.
- [x] Record public HTTPS, ChatGPT registration and Docker runtime limitations explicitly.

## Reproducing checks

From a checkout with Node.js 24+:

```bash
npm ci
npm run verify
npm audit --audit-level=high
npx playwright install chromium
npm run test:e2e
```

On a machine using an installed Google Chrome, the browser command is `COMAND_E2E_CHANNEL=chrome npm run test:e2e`. CI installs Chromium and its OS dependencies in its own runner. This is not an instruction to modify a deployed machine's system packages without authorization.

CI run [41164324625](https://github.com/IMONsergey/comand/actions/runs/41164324625) completed successfully on `adcb7ea1c9eda1504ebe8e2612ac050deb226ef0`, including all four browser cases. The browser workflow uploads `playwright-report` and `test-results` as `browser-report`; failure traces and screenshots are retained. The UI flow writes `overview.png` under its actual Playwright test output directory. The reviewed release images are [comand-desktop.png](images/comand-desktop.png) and [comand-mobile.png](images/comand-mobile.png). The desktop image shows the real Mac instance with four completed tasks. The mobile image shows the real 390-pixel E2E fixture; its overview capture contains one queued and one completed task, a valid snapshot before the next status refresh. Fixture data should not be interpreted as the personal Mac task state.

Use only sanitized lifecycle diagnostics when recording service status. The service CLI now restricts output; raw launchd output, inherited environments and journal contents can contain unrelated credentials. See [OPERATIONS.md](OPERATIONS.md) for operational recovery and [MCP.md](MCP.md) for the protocol contract.
