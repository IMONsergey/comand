# Operations and recovery

## State

Default hub directory: `~/.comand/hub`. It holds `hub.json`, `admin.token`, SQLite state and OAuth encryption key/database. Default agent directory: `~/.comand/agent`, containing the private device config, daemon identity, project locks and per-job evidence. Change directories only via explicit `--data-dir`.

These files are operational state, not repository content. Keep them private and preserve them during code updates. Back up both sides. To make a consistent filesystem backup, stop the hub; wait for or explicitly cancel active jobs before stopping/backing up the agent state. Copy SQLite database and any WAL files together. Do not copy a running database alone with ordinary file-copy tools.

## Task state

| State      | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| queued     | Persisted at hub; awaiting device/working-directory availability |
| dispatched | Reserved for its device; delivery may repeat with the same ID    |
| running    | Device has execution evidence                                    |
| succeeded  | Device reported success                                          |
| failed     | Device reported error/timeout, or owner resolved uncertainty     |
| cancelled  | Cancelled before dispatch or termination confirmed by device     |
| uncertain  | Missing trustworthy outcome; automatic retry prohibited          |

`cancelRequestedAt` is independent of state. When a device is offline, cancellation waits for reconnection. Revoking a device or OAuth connection prevents further authenticated control; it does not undo changes or guarantee immediate termination of already accepted jobs.

## Recover an uncertain job

1. Inspect its saved acceptance, status and output under the agent's `jobs/JOB_ID` directory.
2. Check whether the actual operation finished or left files/services in a partially changed state.
3. Check and stop remaining processes if needed. Never kill unrelated processes based solely on a stale PID.
4. Once the outcome is understood and the recorded group is no longer alive, acknowledge explicitly:

```bash
node dist/agent/cli.js resolve --job JOB_ID --acknowledge --data-dir /absolute/agent-state
```

This releases the execution lock and records failure with the owner's acknowledgment. It does **not** replay the operation. Only create a new job if repeating the requested action is appropriate.

## Diagnostic commands

```bash
node dist/agent/cli.js status --data-dir /absolute/agent-state
node dist/cli.js service status --kind hub --data-dir /absolute/hub-state
node dist/cli.js service status --kind agent --data-dir /absolute/agent-state
curl -f http://127.0.0.1:4310/health
```

The status command redacts device tokens. On Mac, service stdout/stderr are in the corresponding state directory. On Linux, use `journalctl --user -u UNIT_NAME` (the installer prints the exact unit name).

### Linux shells without a user-bus environment

An automation or SSH shell may not inherit `XDG_RUNTIME_DIR` even when the user's systemd manager is already running. Check that `/run/user/$(id -u)/bus` exists, then supply the existing user bus explicitly for service commands:

```bash
env XDG_RUNTIME_DIR="/run/user/$(id -u)" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" \
  node dist/cli.js service status --kind hub
```

The same environment applies to `install` and `restart` and to `--kind agent`. It does not create a missing user manager. `loginctl show-user "$(id -un)" --property=Linger` reports whether services can continue after logout. If lingering is needed but disabled, an administrator must enable it for that user.

## TLS and networking

Keep a directly running hub on `127.0.0.1` and expose it through your existing Nginx/Caddy. Set `--public-url` to the exact HTTPS origin. If listening on a non-loopback address (such as inside Docker), an explicit HTTPS public URL is mandatory. Configure the reverse proxy to preserve the public Host header and allow request bodies of at least 5 MiB. Do not cache API, OAuth or MCP responses.

Persist deployment settings before installing or restarting a hub service:

```bash
node dist/cli.js init --data-dir /absolute/hub-state --host 127.0.0.1 --port 4310 --public-url https://comand.example.com
node dist/cli.js service install --kind hub --data-dir /absolute/hub-state
```

Stop any manually started instance before installing the service. `init` reads explicit flags first, then COMAND_HOST/COMAND_PORT/COMAND_PUBLIC_URL, then existing saved settings. A successful `hub` startup also persists its effective host, port and public URL. Service startup reads this saved configuration; shell environment overrides are not implicitly inherited. Use `init` followed by `service restart` to change a deployed hub's settings. Hub service commands also honor COMAND_DATA_DIR; agent service commands require their own explicit `--data-dir` when using a nondefault state folder.

To retain an explicit browser choice for an agent service, install it with `COMAND_BROWSER_CHANNEL=chrome node dist/cli.js service install --kind agent --data-dir /absolute/agent-state`. Both launchd and systemd definitions preserve this setting. Reinstall and restart the agent service to change or clear it; reinstalling alone does not restart an already running systemd service. Only NODE_ENV, PATH and this explicitly selected browser channel are saved in the service environment.

The agent opens outbound requests. No inbound port on the agent is needed. Its credentials belong to one device and can be revoked. A reconnect uses the existing durable execution ID; it is not permission to repeat a command.

For a new public hostname, point DNS to the server and install a valid TLS certificate before connecting other devices. This repository does not silently modify DNS, firewall rules, existing VPN configuration or other sites.

## Updates

Save state, finish active work, update code with `git pull --ff-only`, run `npm ci` and `npm run build`, restart the hub/agent services. Re-run `npm run verify` when building changes locally. Do not replace or regenerate owner/device credentials as part of a routine update.

## Retention

Per-job logs stop at 10 MiB with an explicit truncation marker. Results are bounded. Completed local evidence is retained to prevent replay and support recovery; automatic retention/compaction is not implemented. Monitor free disk space. Do not delete a job's acceptance record while the hub may still deliver that job. History export/archival should be added before using this release as a high-volume multi-year service.
