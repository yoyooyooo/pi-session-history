# Contributing

Contributions are welcome through issues and pull requests.

## Development setup

Requirements:

- Node.js 22 or newer.
- npm 10 or newer.
- Pi 0.80.10 or newer for host-level smoke tests.

Install dependencies:

```bash
npm install
```

Run the full local quality gate:

```bash
npm run check
```

Individual checks are also available:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
```

## Pull requests

Keep changes focused and include:

- A concise explanation of the behavior being changed.
- Tests for new behavior and regressions.
- README updates when Tool parameters, storage behavior, compatibility, or security boundaries change.
- The commands used to verify the change.

For changes to session parsing or search behavior, test both sanitized fixtures and at least one realistic local corpus when possible. Never commit private session transcripts; reduce reproductions to synthetic fixtures first.

## Coding conventions

- Use strict TypeScript and ES modules.
- Keep filesystem discovery and transcript processing read-only.
- Keep Tool output bounded.
- Preserve cancellation through `AbortSignal`.
- Do not add network transmission of session contents without an explicit design and security review.
- Do not hard-code local paths, usernames, credentials, or machine-specific configuration.

## Host smoke test

Load the local checkout without installing it:

```bash
pi -e . --list-models
```

You can also install the checkout and reload Pi:

```bash
pi install .
```

Confirm that `pi_history` is available to the Agent and `/history` appears in command discovery. Changes to packaging or host integration should also be tested from an actual `npm pack` tarball in an isolated directory.

## Reporting security issues

Do not open a public issue for a vulnerability involving unintended file access or disclosure of session contents. Follow [SECURITY.md](SECURITY.md) instead.
