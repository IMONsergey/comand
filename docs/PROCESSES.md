# Persistent process sessions

Comand can keep a command or REPL running between requests, send it UTF-8 stdin, read its merged stdout/stderr and stop its process group. Sessions use **pipes, not a PTY**. Programs that require a controlling terminal, terminal resizing, full-screen interfaces or password prompts that read `/dev/tty` are not supported. Use explicit interactive/unbuffered options where needed, such as `python3 -u -i` or `node -i`.

Every process operation is an ordinary durable project job. Submit the operation, retain its job ID, then read that same job until it finishes. A successful `process.start` job means the broker started; it does **not** mean the command finished successfully. Its result contains the `sessionId` used by subsequent operations.

| MCP tool | Operation | Required fields beyond `projectId` | Result of the job |
| --- | --- | --- | --- |
| `start_process` | `process.start` | `command`, `idempotencyKey` | Session metadata, including `sessionId` |
| `interact_with_process` | `process.input` | `sessionId`, `input`, `idempotencyKey` | Accepted UTF-8 byte count and stdin state |
| `read_process_output` | `process.output` | `sessionId` | Session metadata, text, base64 bytes, `nextOffset`, `hasMore` |
| `list_sessions` | `process.list` | — | Metadata for sessions in this exact project |
| `force_terminate` | `process.stop` | `sessionId`, `idempotencyKey` | Confirmed session state |

All five tools require `comand:execute` and local `--allow-shell`, including session output and listing. Generic `get_job`/`get_job_logs` also require execute permission for process jobs. Generic summaries omit stdin content and job results. Each session belongs to the exact project ID, device ID, canonical working directory and agent state directory. Knowing another session ID does not grant access to it through a different project or enrollment.

Example sequence:

1. Call `start_process` with `command: "python3 -u -i -q"`, a project ID and a new intent key. Wait for its job result and save `sessionId`.
2. Call `interact_with_process` with that project/session, `input: "value = 40\nprint(value + 2)\n"` and a new intent key. Newlines are explicit; Comand does not append one.
3. Call `read_process_output`, wait for its job result, and pass the returned byte `nextOffset` to the next read. Read again later if the process has not produced output yet.
4. Send `input: ""` with `closeStdin: true` to deliver EOF, or use `force_terminate` to stop the group.

An accepted stdin byte count means bytes entered the process pipeline. It is not proof the application parsed or completed the requested work. Inspect output and command-specific evidence. The exact base64 `data` field lets clients reconstruct UTF-8 even when a byte chunk splits a multibyte character; `text` is a convenient decoding of the individual chunk.

## Limits and concurrency

- Commands: 32,768 characters. Stdin: 65,536 UTF-8 bytes per request.
- Timeout: one hour by default, configurable from one second through 24 hours. The timeout starts when the broker launches the group and continues while the hub/agent is offline.
- Reads: 16 KiB by default, up to 64 KiB per job. Merged output is capped at 10 MiB with a visible truncation marker. Output capture uses backpressure; bytes after the cap are drained and discarded.
- A project can have 16 active or uncertain sessions and 500 retained sessions. Session history, request receipts and output are not automatically deleted. Archive only after locally verifying processes are stopped and preserving any uncertainty evidence you need.
- List results contain status, times, exit code, stdin state, byte count and truncation state. They contain neither command lines nor stdin/output payloads.

Existing hub/device project locks still serialize the short operation jobs. A successful start job releases its job lock while its process remains alive. Persistent sessions can therefore coexist with other sessions, file operations and commands in the project. Coordinate writes yourself. A session is not an exclusive filesystem lock, and shell access is not an OS sandbox: it has the agent user's operating-system permissions.

## Recovery and stopping

A detached broker owns each session. The agent and hub can restart without losing the process or REPL state. There is no shell HTTP listener: control uses private per-job request files and a private parent/child IPC channel. Session directories are mode `0700`; state, requests, claims and logs are mode `0600`.

Start and stdin/stop requests have permanent acceptance records. Before applying stdin the broker durably writes a claim; an interrupted claimed request is never automatically repeated. Reuse the **same intent key and identical arguments** after a transport error. Do not create a new key to retry an uncertain side effect.

The process group has a dedicated live leader. Only that leader signals its own group, using SIGTERM and then SIGKILL after a 1.5-second grace period. The broker communicates through its child IPC handle; a recovered agent never sends a signal using a PID from saved state. Normal command exit also cleans up background descendants. Programs that deliberately leave the process group are outside this guarantee.

If a broker dies, its child detects the lost IPC channel and stops its own group. The saved session nevertheless becomes `uncertain` after its heartbeat is stale: Comand cannot manufacture a confirmed command outcome. A lost or unresponsive broker is not restarted, stale PIDs are not killed, and uncertain stdin is not replayed. Inspect the device locally. A process operation whose own side effect is uncertain retains the ordinary uncertain-job project lock until the owner follows the existing explicit job-resolution procedure. A read can successfully report an uncertain session without claiming the command succeeded.

`force_terminate` is the session stop operation. Cancelling an already completed start job does not stop the session. Stopping/restarting the polling agent or revoking its hub access does not cancel already accepted work. Use session stop while connected, or inspect and stop locally when immediate shutdown is required.

Session states are `starting`, `running`, `exited`, `stopped`, `timed_out`, `failed` and `uncertain`. `exited` includes nonzero exit codes; inspect `exitCode`. These are distinct from the short operation job's status.

## Verification

`tests/processes.test.ts` uses real Node/Python interactive processes, real process groups and filesystem receipts. It covers deduplication, EOF, project/device/state isolation, shell opt-in, UTF-8 byte bounds/cursors, output truncation, resistant descendants, timeout, broker loss, incomplete acceptance capacity, and a real agent kill plus hub restart that preserves a Node REPL variable without repeating start. `tests/mcp.test.ts` checks the process tools and prevents read-only grants from bypassing process permissions via generic job tools.

Python-specific coverage is skipped only if `python3` is absent. The pipe implementation targets macOS/Linux; Windows is unsupported.
