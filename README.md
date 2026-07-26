# pi-session-history

[English](./README.md) | [中文](./README.zh-CN.md)

Search, inspect, and resume historical [Pi](https://github.com/earendil-works/pi) coding-agent sessions without leaving the agent.

After installation, ask Pi:

```text
Search my previous sessions for "database migration", then open the most relevant result.
```

The Agent can call the read-only `pi_history` Tool to search Pi's local JSONL session store and read a normalized transcript range. Interactive users can run `/history` to preview, hand off, or resume a session.

## Why this exists

Pi stores useful decisions, failed attempts, tool output, and implementation context in local session files. Its built-in session picker helps resume a known conversation, but an Agent cannot otherwise search prior sessions as working material. `pi-session-history` exposes that local history through one bounded, read-only Tool.

## What you get

- Cross-project lexical search, or filtering to the current working directory.
- Normalized messages, reasoning, tool calls, and tool results through [`@letta-ai/trajectory`](https://github.com/letta-ai/trajectory).
- Record-based pagination for transcript reads.
- Active-session exclusion by default to avoid self-matches.
- An interactive `/history` picker with preview, Agent handoff, and resume actions.
- No index, telemetry, or network transmission of session contents.

## Requirements

- Pi `0.80.10` or a compatible later release. CI pins the host packages to `0.80.10`.
- Node.js `22` or newer. Pi 0.80.10's packaged runtime dependencies do not load reliably on Node.js 20.

## Install

### npm

```bash
pi install npm:pi-session-history
```

### Git

```bash
pi install git:github.com/yoyooyooo/pi-session-history
```

### Local checkout

```bash
git clone https://github.com/yoyooyooo/pi-session-history.git
cd pi-session-history
npm install
pi install .
```

Restart Pi or run `/reload` after installation.

## Quick start

1. Install and reload the package.
2. Ask Pi:

   ```text
   Find my earlier Pi sessions about cache invalidation and summarize the relevant decision.
   ```

3. The Agent should call `pi_history` with `action: "search"`, then call `action: "read"` with an exact returned path.
4. A successful search result includes the session title, path, working directory, update time, matched excerpts, and pagination metadata.

For direct interactive use:

```text
/history
/history cache invalidation
```

To verify loading without changing Pi settings:

```bash
pi --no-extensions -e . --list-models
```

## Agent Tool

The package registers one Tool:

```text
pi_history
```

It supports three actions.

### Search

```json
{
  "action": "search",
  "query": "database migration",
  "limit": 10
}
```

Search is case-insensitive and lexical. Whitespace-separated terms use AND semantics: every term must occur somewhere in the same session, but terms may occur in different records.

### List

```json
{
  "action": "list",
  "limit": 10,
  "scope": "cwd"
}
```

`scope` may be:

- `all` — inspect every project in the local Pi store; this is the default.
- `cwd` — include only sessions whose recorded working directory equals the current Pi working directory.

### Read

Use the exact path returned by `search` or `list` whenever possible:

```json
{
  "action": "read",
  "session": "/home/me/.pi/agent/sessions/.../session.jsonl",
  "offset": 0,
  "recordLimit": 80,
  "maxCharacters": 30000
}
```

If `details.hasMore` is true, continue from `details.nextOffset`. If `details.recordTruncated` is true, retry the same offset with a larger `maxCharacters` value before advancing.

Exact paths are accepted only when they resolve inside the configured Pi sessions directory. A session ID is also accepted when it uniquely identifies a session inside the selected `scanLimit`.

### Parameters

| Parameter        | Used by          | Default |   Limit | Description                                         |
| ---------------- | ---------------- | ------: | ------: | --------------------------------------------------- |
| `query`          | `search`         |       — |       — | Required lexical query.                             |
| `session`        | `read`           |       — |       — | Required session ID or exact result path.           |
| `scope`          | all              |   `all` |       — | `all` or `cwd`.                                     |
| `limit`          | `list`, `search` |    `10` |    `50` | Maximum returned results.                           |
| `scanLimit`      | all              |  `1000` |  `5000` | Newest session files considered.                    |
| `includeCurrent` | all              | `false` |       — | Include the active session file.                    |
| `offset`         | `read`           |     `0` |       — | Normalized record offset.                           |
| `recordLimit`    | `read`           |    `80` |   `200` | Records considered for one response.                |
| `maxCharacters`  | `read`           | `30000` | `50000` | Character budget before the global Tool-output cap. |

Every Tool response is also capped at 50 KiB of UTF-8 and 2,000 lines, whichever is reached first.

## Interactive command

```text
/history
/history database migration
```

The command opens a session picker and offers three actions:

1. Preview the normalized transcript.
2. Insert a prompt asking the Agent to inspect the selected session.
3. Resume the selected Pi session.

The command requires Pi's interactive UI. The `pi_history` Tool is the autonomous Agent interface.

## Storage and performance

The extension discovers sessions from:

1. `$PI_CODING_AGENT_DIR`, when set.
2. `~/.pi/agent`, otherwise.

Session files are expected under `<agent-dir>/sessions/<project>/*.jsonl`.

Additional behavior:

- `list` stops after collecting the requested number of eligible sessions.
- `search` scans the complete selected `scanLimit` so ranking is meaningful.
- Complete JSONL lines are grouped into approximately 1 MiB normalization batches. One oversized JSONL line may exceed that batch target.
- Malformed or unreadable sessions are skipped and counted.
- Partial or interrupted sessions are accepted when they contain usable records.
- The package does not maintain a persistent index, so search cost scales with the selected corpus.

## Privacy and security

Pi extensions execute with the user's permissions. Review extension source before installing it.

`pi-session-history` is read-only:

- It does not modify or delete session files.
- It does not make network requests.
- It returns local session paths because follow-up reads need stable identifiers.
- Exact-path reads are confined to the configured Pi sessions directory after canonical path and symlink resolution.
- Search results and transcript reads are bounded before they enter Agent context.

Session contents may contain source code, tool output, file paths, credentials printed by other tools, or other sensitive data. Treat Tool results and logs accordingly.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Limitations

- Search is lexical, not semantic or embedding-based.
- Conversation branches share one append-only JSONL file. Normalized reads preserve recorded file order rather than selecting only the active branch.
- `@letta-ai/trajectory` bounds large tool arguments and tool results during normalization.
- The package reads Pi's current SessionManager JSONL shape through trajectory's compatible OpenClaw adapter.

## Update and uninstall

```bash
pi update npm:pi-session-history
pi remove npm:pi-session-history
```

For Git installs, use `pi update --extensions` or install a new pinned ref.

## Development

```bash
npm install
npm run format:check
npm run lint
npm run typecheck
npm test
npm run check
```

`npm run check` runs formatting checks, lint, type checking, tests, and an npm package dry run.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution expectations. Releases use version tags and npm Trusted Publishing through `.github/workflows/publish.yml` after the initial package publication.

## License

[MIT](LICENSE)
