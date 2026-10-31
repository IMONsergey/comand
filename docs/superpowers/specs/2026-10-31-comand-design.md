# Comand: design and implementation contract

## Intent and authority

Sergey authorized end-to-end development in IMONsergey/comand after discussing a self-owned Desktop Commander alternative. This is a new empty repository. Implement a usable single-owner v0.1 with Mac/Linux agents, durable jobs, an actual web UI and standard MCP. Product decisions below are implementation choices, not new user requirements. Do not stop for routine approvals. Do not disturb existing VPN/web deployments.

## Approach

Use a small TypeScript hub and device worker with independent persistence. DesktopCommanderMCP remains an optional interoperable tool, not a source of proprietary remote code. We considered deep-forking DC and a completely bespoke GUI operator: both unnecessarily couple job reliability to an upstream process and expand scope. Core file/command operations need controlled durable execution, so implement them in the supervisor; standard MCP provides compatibility. A future persistent upstream-tool adapter may reuse DC's richer tools. Do not claim that adapter exists unless implemented.

## Stack and boundary

Node >=24, native SQLite, Express 5, MCP SDK 1.32.2, Zod, React 19/Vite, IBM Plex Sans/Mono bundled locally. No Supabase, no LLM API, no fake data, no cloud dependency for the hub. English code and Russian product UI. Initial hub loopback-only. Remote mode requires public HTTPS via reverse proxy, authentication, and explicit host/URL settings. Shell is an opt-in trusted-owner capability, not an OS sandbox. Agent file APIs enforce real project paths within locally allowed roots; ignore symlinks during recursive traversal. Reject symlinks in mutation paths. Server and agent state/credentials are never committed.

## Execution and durability

Jobs have explicit project/device IDs and a caller-provided idempotencyKey. Same key+payload returns the same job; mismatch is 409. No automatic retry of a command, ever. Hub persists before dispatch. Queued/dispatched jobs may be re-delivered only to the same device. Device SQLite or exclusive durable acceptance deduplicates each job before spawning a detached supervisor. A supervisor owns command process group, bounded file logs and atomic status/result. Loss of hub/agent connection does not kill it. On recovery, use saved evidence, never respawn accepted work. Lost evidence is `uncertain`, which retains the project lock. One active job per project including uncertain, enforced by hub and device. Cancellation is requested until supervisor proves completion/cancellation. Real errors and uncertainty visible in UI. Logs capped per job with an explicit truncation marker. No arbitrary silently replayed writes.

## Operations

Shared source of truth is src/shared/protocol.ts. Native operations: command, files.list/read/write/search/mkdir/move and opt-in browser.inspect (fresh isolated headless Chromium, page metadata and bounded screenshot). Writes support expectedHash conflict detection and createOnly. File reads return content, hash, offset and truncated indication. Binary and overlarge files produce explicit errors. Browser is URL inspection/screenshot, not generic desktop control. Browser dependency missing produces actionable error. Figma/native GUI control is not implemented or advertised as such.

## API contract

All /api owner routes accept admin bearer token OR a HttpOnly SameSite=Lax browser session with X-Comand-CSRF on mutations. GET /api/session is public and returns SessionInfo. POST /api/login {token} sets cookie and returns SessionInfo. POST /api/logout clears session. Login rejects foreign Origin. CSRF and Origin checks are mandatory for cookie mutations. No permissive CORS.

GET /api/overview -> Overview; GET /api/devices -> Device[]; POST /api/pairings -> Pairing (one-time, 10min); POST /api/devices/:id/revoke -> Device. GET /api/projects -> Project[]; POST /api/projects {deviceId,name,root,notes?} -> Project; PATCH /api/projects/:id {name?,notes?} -> Project. GET /api/jobs -> Job[]; POST /api/jobs -> Job (201 new, 200 replay allowed); GET /api/jobs/:id -> Job; POST /api/jobs/:id/cancel -> Job; GET /api/jobs/:id/logs?offset=0&limit=65536 -> LogChunk. JSON errors use {error,code?}. No unauthenticated internal details at /health.

Agent: POST /api/agent/enroll body AgentEnrollment -> AgentCredentials. POST /api/agent/poll bearer device token -> PollResponse (server assigns dispatch atomically, redelivers existing dispatches and sends cancellation IDs). POST /api/agent/jobs/:id/update bearer device token body JobUpdate -> {logBytes:number,status:JobState}; log.data is base64 raw bytes at byte offset. Duplicate same log range accepted, gaps rejected. Do not accept updates for another device, queued jobs, or impossible state regression. Credentials revoke checked for every poll/update. Agent config JSON mode0600 stores registered roots/capabilities. Device names/paths/operation inputs validated and bounded.

## Hub code contract

src/hub/server.ts exports createHub(options: HubOptions): Promise<HubRuntime>. HubOptions {dataDir:string,adminToken:string,host?:string,port?:number,publicUrl?:string,webDir?:string}. HubRuntime {app:Express,store:HubStore,auth:HubAuth,start():Promise<string>,close():Promise<void>}. Creation installs REST/static routes without listening; root adds MCP/OAuth before start. HubAuth {isOwner(req:Request):boolean,requireOwner:RequestHandler,validateCsrf(req:Request):boolean}. Store synchronous methods: listDevices(),getDevice(id),createPairing(),enroll(input),revokeDevice(id),listProjects(),getProject(id),createProject({deviceId,name,root,notes?}),updateProject(id,{name?,notes?}),listJobs(limit?),getJob(id),createJob(input),cancelJob(id),getLogs(id,offset?,limit?),poll(deviceId),updateJob(deviceId,input). Return protocol types. Agent authentication helper can remain internal. Store throws errors with status/code for invalid operations. HubStore creates admin-token hashes/device-token hashes; never returns device secrets except enrollment. Root owns OAuth persistence in separate DB and CLI.

## UI contract

Overview/jobs/devices/projects/settings navigation; live counts from real API, empty states with actionable connect flow, login, one-time pairing, device revoke, project creation, notes editing, new task form with command/files/browser choices, job filtering/detail/log streaming/cancel. Responsive keyboard-accessible Russian UI. No secrets stored in localStorage, rendered command secrets not copied into toast/history unnecessarily. No pseudo-progress percentage; display actual state and last heartbeat. Errors persist until resolved. All user input escaped by React; never innerHTML for logs. App API module sends CSRF from session.

## Acceptance

Unit/integration tests on real SQLite, real processes and temp dirs. HTTP unauthenticated/CSRF/device isolation/idempotency/state/log/security tests. Durable task survives agent and hub restart; duplicate delivery does not repeat command; cancellation stops process group; dead supervisor becomes uncertain. Path traversal/symlink/write conflicts rejected. MCP initialize/tools/call via official Client over HTTP, OAuth PKCE and replay tests. Browser visual and interaction checks desktop/mobile, real fixture device and job. Build/typecheck/test before publishing. Install and exercise on available Mac/Linux with dedicated directories. Real ChatGPT connection requires connector registration; report precisely if that last account-level step is unavailable.

## Release 0.1.0 acceptance checkpoint (2026-10-31)

This contract states intended behavior. Completed checks and external limitations are documented separately in [VERIFICATION.md](../../VERIFICATION.md); the presence of a requirement above is not evidence that its deployment or account integration was verified.

- [x] Local core verification: 40 passing tests, typecheck and production build; Ubuntu/macOS core CI passed, with one Linux-only parser test skipped on macOS.
- [x] Real macOS launchd installation and live hub/agent restart recovery, one execution, idempotency and full UTF-8 logs; official MCP discovery/file read and isolated JPEG inspection passed.
- [x] Real Linux systemd user installation and live hub/agent restart recovery, one execution, idempotency and full UTF-8 logs; official MCP discovery/file read passed.
- [x] Final desktop/mobile browser suite after the mobile viewport fix: all four cases passed in [CI run 41164324625](https://github.com/IMONsergey/comand/actions/runs/41164324625) on adcb7ea.
- [x] Final screenshots reviewed and saved in docs/images/; separate real-Mac Chrome run passed all four E2E cases in 39.9 seconds on the built adcb7ea application.
- [x] Installed executable revision adcb7ea1c9eda1504ebe8e2612ac050deb226ef0 verified on both platforms; hub and agent services rebuilt/restarted and running with last exit code zero. Labels, PIDs and sanitized lifecycle observations are recorded in VERIFICATION.md. Subsequent verification-documentation publication is a separate documentation-only commit.

The two current installations use independent local loopback hubs. A shared public HTTPS hub has not been deployed; domain/DNS and authorized root proxy access were unavailable. ChatGPT account registration has not been performed. Docker configuration exists, but its runtime deployment has not been tested. These remain explicit limits of the delivered verification.
