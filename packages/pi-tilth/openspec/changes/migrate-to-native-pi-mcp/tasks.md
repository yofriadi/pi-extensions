## 1. Dependencies and Configuration

- [x] 1.1 Update `package.json`: add `@earendil-works/pi-mcp` to `dependencies: "^0.99.1"` (runtime dependency only, no devDependencies entry); update `@earendil-works/pi-coding-agent` peer dependency to `>=0.99.1`; remove `"mcporter"` from package keywords and description
- [x] 1.2 Run `pnpm install` and execute a minimal sanity probe against `tilth --mcp` with `@earendil-works/pi-mcp` verifying the connection-scoped dedup assumption early
- [x] 1.3 Update `src/lib/config.ts`: add optional `connectTimeoutMs?: number` to `TilthConfig`, drop `serverName`, update `normalizeConfig` and `loadConfig`, and document that `callTimeoutMs` cancels the active request via MCP instead of killing the process

## 2. In-Process MCP Transport and Availability

- [x] 2.1 Implement `TilthMcpTransport` in `src/lib/transport.ts` wrapping `McpClient` and `StdioTransport` from `@earendil-works/pi-mcp`:
  - Pass required `{ name: "pi-tilth", version: packageJson.version }` to `McpClient` constructor
  - Pass `requestTimeoutMs: connectTimeout` (default 120s for npx, 30s for binary) to `new McpClient()` for initialize budget
  - Retain wrapper reference to `StdioTransport` with `closeTimeoutMs: 2000` (default)
  - Memoize in-flight `connectPromise` and clear it on both rejection and client close
  - Race caller signal against connect so the caller returns early if aborted
  - Auto-healing: listen to `client.onClose()` with identity check (`if (client !== this.client) return`); reconstruct fresh `StdioTransport` and `McpClient` on next call (at most one reconnect per call)
  - Idempotent clean shutdown: set `disposed = true` so post-shutdown calls do not respawn, and call `await client.close()`
- [x] 2.2 Refactor `src/lib/availability.ts`:
  - Delete `"config"` member of `TransportMode`, `AdHocDescriptor`/`getAdHocDescriptor`, `serverName` parameter of `refresh()`, and mcporter text inside `unavailableMessage()`
  - Probe local `tilth` binary and `npx` fallback directly (using `pi.exec`) without requiring `mcporter`
- [x] 2.3 Remove `src/lib/mcporter.ts` and repurpose `src/lib/result.ts` to convert `CallToolResult`:
  - Join `TextContent` blocks
  - Map `isError: true` to `ServerToolError`
  - Capture stderr from attempt transport before any reconnect and rethrow pi-mcp errors as `TransportError`
  - Preserve `ServerToolError` and `TransportError` exports from `src/toolkit.ts`
- [x] 2.4 Update `src/toolkit.ts` (`runTilthCall`) to route requests through `transport.callTool()`
- [x] 2.5 Update `src/index.ts` to wire lifecycle: probe availability and construct transport wrapper on `session_start` (with lazy stdio connection on first tool call), and idempotent teardown (`await transport.stop()`) on `session_shutdown`

## 3. Scoping, Commands, and Hashline Verification

- [x] 3.1 Verify full scoping contract in `src/lib/scope.ts`:
  - `path`, `paths`, `scope`, and `context` are absolutized against `sessionCwd`
  - Caller-supplied absolute `root` passes through unchanged
  - Search-root tools (`search`, `list`, `grok`, `deps`) inject `scope: root` when omitted
  - `read` and `diff` receive no scope injection
  - Git revisions (`a`, `b`, `log`) are never path-resolved
  - Update comments in `src/lib/scope.ts` to reflect native MCP cwd mechanics
- [x] 3.2 Update `src/commands/savings.ts` to invoke `tilth_savings` over the active persistent transport, surfacing whatever the server reports, with connection triggered if uninitialized
- [x] 3.3 Verify repeat-read dedup and hashline interaction:
  - Assert a repeated identical query over the persistent transport elides previously-shown content with `[shown earlier]` (tilth 0.10.1 elides search expansions; direct repeat full-reads are not elided)
  - Assert `[shown earlier]` passes through unannotated without corrupting `pi-hashline-edit` snapshot store

## 4. Test Suite and Documentation Updates

- [x] 4.1 Update `test/host-deps.test.ts` to verify `@earendil-works/pi-mcp` is declared in `dependencies`, is NOT in `peerDependencies`, and its resolved version satisfies `^0.99.1`
- [x] 4.2 Update `test/raw-param.test.ts`: replace `{}` AbortSignal stubs with `undefined` to prevent `addEventListener` TypeErrors, and adapt test setup to the new transport seam (removing `serverName`, `mode: "config"`, and mcporter CLI argv checks)
- [x] 4.3 Update transport test suite:
  - Preserve existing `scope` and `config` describe blocks (move to `test/lib/scope.test.ts` and `test/lib/config.test.ts` or retain in place)
  - In `test/lib/transport.test.ts`, test `TilthMcpTransport` using fake/in-memory transport from `@earendil-works/pi-mcp/testing`: test connection lifecycle, auto-healing reconnect, connect timeout, concurrent connect memoization, and stderr surfacing
- [x] 4.4 Update `test/tools.test.ts`, `test/flag.test.ts`, and `test/loader.test.ts` to work with the native transport interface
- [x] 4.5 Update `test/integration/roundtrip.test.ts` to test real in-process MCP stdio connection against `tilth --mcp`
- [x] 4.6 Update `README.md`, `CHANGELOG.md`, `skills/tilth/SKILL.md`, `vitest.integration.config.ts`, and all module docstrings:
  - Remove all `mcporter` prerequisites, transport knobs, and setup instructions
  - Document the new schema fixture refresh procedure via `client.listTools()` over the in-process transport instead of `mcporter list --schema`
  - Document that an auto-heal server restart zeroes tilth's session counters
- [x] 4.7 Final verification: run `pnpm run check`, run `pnpm test`, run opt-in integration tests against `tilth --mcp`, and verify `openspec validate migrate-to-native-pi-mcp` passes cleanly
