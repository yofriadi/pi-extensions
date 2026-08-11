# pi-mlflow

MLflow tracing extension for the [pi coding agent](https://github.com/earendil-works/pi).
Traces each pi turn-cycle (one prompt through its tool calls and response) as an MLflow trace against a local, user-managed MLflow Tracking Server.

This is a personal, local-only observability add-on: it does not manage the `mlflow server` process, does not expose any MCP/tool surface to the LLM, and disables itself silently (no retries, no interactive warnings) if the tracking server isn't reachable.

## Setup

1. Run your own MLflow Tracking Server, for example.
   Keep both the SQLite backend and artifacts under a persistent directory; do **not** use `/tmp` because it may be cleared during restart/reboot:

   ```bash
   pip install 'mlflow[genai]'
   mkdir -p "$HOME/.mlflow-server/mlartifacts"
   mlflow server \
     --port 5055 \
     --backend-store-uri "sqlite:///${HOME}/.mlflow-server/mlruns.db" \
     --serve-artifacts \
     --artifacts-destination "$HOME/.mlflow-server/mlartifacts"
   ```

2. Install the extension in your pi project.
   From this monorepo: `pi install ./packages/pi-mlflow` (or `.pi/extensions/` / `pi install npm:@yofriadi/pi-mlflow` once published).

3. Optionally add a `pi-mlflow.json` file in your project root (see `pi-mlflow.example.json`):

   ```json
   {
     "trackingUri": "http://localhost:5055",
     "captureContent": true
   }
   ```

   All fields are optional.
   `trackingUri` and `captureContent` default to the values above; `experimentName` defaults to the basename of the project working directory — so each project gets its own experiment — falling back to `"pi"` when the basename is empty (e.g. running from a filesystem root).

   `captureContent` gates full prompt/tool/LLM bodies **and** MLflow Chat Sessions conversation text (root turn Inputs/Outputs / bubbles).
   It defaults to `true` so Sessions bubbles work out of the box; set `false` for structure-only traces.

   > ⚠️ **Pointing `trackingUri` at a shared or team MLflow server?**
   > Content capture is on by default, so full prompt text, tool call arguments/outputs, and LLM request/response bodies will be sent to that server.
   > Set `"captureContent": false` to send structure only.

   **Migrating from the old defaults?**
   Pin `"experimentName": "pi"` and `"captureContent": false` to restore the previous single-bucket, structure-only behavior.

4. Authenticate against a protected tracking server with the same env vars the MLflow TypeScript SDK uses (credentials must **not** be embedded in `trackingUri` — config validation rejects userinfo):

   - Basic auth: `MLFLOW_TRACKING_USERNAME` + `MLFLOW_TRACKING_PASSWORD`
   - Bearer token: `MLFLOW_TRACKING_TOKEN`

   `/mlflow` still redacts userinfo if a URI somehow still contains it, but the supported authentication path is environment variables only.

5. Run `pi`.
   On the first `session_start`, the extension resolves (or creates) the configured experiment and initializes tracing.
   Use `/mlflow` to check status at any time.

   Config and the SDK init are cached for the process lifetime: editing `pi-mlflow.json` and reloading the extension does **not** re-read config or re-init against a new server — restart pi to pick up changes.

## What gets traced

- One MLflow trace per turn-cycle (`agent_start` → `agent_settled`), grouped across a session via the `mlflow.trace.session` metadata key.
- `AGENT` root span → `CHAIN` span per turn → `LLM` span per assistant response → `TOOL` span per tool call (keyed by `toolCallId`, correctly handling parallel tool execution).
- Compaction events are traced according to trigger and timing: nested under the current turn for overflow-triggered compaction, under the root span for manual/threshold compaction between turns, and not traced at all when no turn-cycle is active.
- Always-on structural metadata: token usage (`mlflow.chat.tokenUsage`), cost (`mlflow.llm.cost`), git commit/remote, turn/attempt indices, compaction stats.
- Full content (prompt text, tool arguments/outputs) is recorded by default; set `"captureContent": false` in the config for structure-only traces.
- **MLflow Chat Sessions** conversation bubbles / turn Inputs–Outputs also require content capture, which defaults to enabled.
  With `"captureContent": false`, structural tracing still works (Traces drawer, session grouping, token/cost metadata), but the Sessions turn body stays empty by design.

## `/mlflow` command

Shows the configured tracking URI (with any embedded userinfo redacted), resolved experiment (name + id), capture-content mode (including that it controls Sessions conversation text as well as child span bodies), and whether tracing is active or disabled (with the reason).
Never displays captured trace content.

## Data durability and recovery

The tracking server stores metadata in `mlruns.db` and trace payloads in `mlartifacts`; both are required.
The repository helper stores them in `$HOME/.mlflow-server` by default.
`MLFLOW_SERVER_DIR` may override this, but it should point to a persistent, backed-up directory—not `/tmp`.

If a server was previously started with another directory, changing the directory does not migrate data.
Stop the server, make a backup, then restart it with the directory containing the desired `mlruns.db` and `mlartifacts`:

```bash
cp -a "$HOME/.mlflow-server" "$HOME/.mlflow-server.backup.$(date +%Y%m%d-%H%M%S)"
MLFLOW_SERVER_DIR="$HOME/.mlflow-server" pnpm run mlflow:server
```

If both old and new stores contain traces, keep both directories until you have verified the recovery.
Do not copy one SQLite database over the other while the server is running; the database and artifact tree must remain matched.
Combining two stores with colliding experiment/artifact IDs requires an MLflow/API-level migration rather than a blind file copy.

## Known limitations

- No write-ahead-log-style durability: a tracking-server outage during a flush can lose that turn-cycle's trace batch.
  Flushing is awaited at `agent_settled` (so a crash after settlement cannot lose a finished cycle) and again at `session_shutdown` (orphan-span sweep + final flush).
  Export failures remain accepted without a local WAL.
- Process-global setup cache / OTel singleton: config changes and tracking-server switches require restarting the pi process; `/reload` alone is not enough.
- No session-level aggregate/timeline trace view; sessions are browsable only via the `mlflow.trace.session` metadata tag and MLflow's trace search.
- Cost tracking uses the `mlflow.llm.cost` span attribute manually, since MLflow's TypeScript SDK does not yet compute cost automatically (see [MLflow's token usage & cost docs](https://mlflow.org/docs/latest/genai/tracing/token-usage-cost/)).

## Development

```bash
pnpm install
pnpm run check   # biome check
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest (unit + skips real-server suite if no server)
```

Real-server verification (tasks 6.1–6.7) needs a local tracking server configured for the TypeScript SDK's artifact client:

```bash
# The helper defaults to $HOME/.mlflow-server; override only with a persistent path.
MLFLOW_BIN=/path/to/mlflow pnpm run mlflow:server
# or start MLflow directly using the persistent paths above.
# In another shell:
pnpm run test:integration
```

`scripts/run-mlflow-server.sh` starts sqlite-backed MLflow with `--serve-artifacts` so exported traces include full span trees retrievable via the REST/artifact APIs.

The extension itself needs no build step: pi loads TypeScript extensions directly via `jiti`.
