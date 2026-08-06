# Model Debugger — Pi Extension

Logs all Pi model interactions to help debug silent failures, rate limiting, and model selection issues.

## Install

Published on npm: [`model-debugger`](https://www.npmjs.com/package/model-debugger). Use **Pi's package manager** (`pi install`), not `npm install` alone.

```bash
pi install npm:model-debugger
pi install npm:model-debugger@1.0.0   # pin version
pi install -l npm:model-debugger        # project-local (.pi/settings.json)
pi -e npm:model-debugger              # one session, no install
```

Then run `/reload` in Pi (or restart).

```bash
pi list
pi update npm:model-debugger
pi remove npm:model-debugger
```

**From [pi-extensions](https://github.com/luongnv89/pi-extensions) (git):**

```bash
cp -r extensions/model-debugger ~/.pi/agent/extensions/model-debugger
```

## Usage

Inside Pi TUI:

| Command                   | Description                                           |
| ------------------------- | ----------------------------------------------------- |
| `/debug-status`           | Show current debugger status                          |
| `/debug-toggle [on\|off]` | Enable or disable logging (persisted across restarts) |
| `/debug-logs [N]`         | Show last N log entries (default: 100)                |
| `/debug-clear`            | Clear the log file                                    |
| `/debug-help`             | Show all commands                                     |

## Log file

```
~/.pi/agent/logs/model-debugger.log
```

## Safety

- Logs **only** write to file, never to console (won't interfere with response streaming)
- Auto-trims at 5 MB / 10,000 lines on each Pi start
- Can be fully disabled at runtime with `/debug-toggle off` — zero file writes when disabled

## License

MIT
