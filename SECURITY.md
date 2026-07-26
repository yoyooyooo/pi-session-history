# Security Policy

## Supported versions

Until the project reaches 1.0, security fixes are applied to the latest published minor version only.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository. If private reporting is unavailable, contact the maintainer through the repository profile instead of opening a public issue.

The maintainer aims to acknowledge a complete report within 7 days and provide an initial assessment or status update within 14 days. Complex fixes may take longer; reporters will receive material status changes through the private thread.

Include:

- The affected version.
- Reproduction steps using synthetic or redacted session data.
- The file-access or disclosure impact.
- Any proposed mitigation.

Do not include real session transcripts, credentials, private source code, or sensitive local paths in a report.

## Security boundary

The extension runs with the same local permissions as Pi and reads Pi's session store. Its intended boundary is:

- Read-only access to session JSONL files.
- No network transmission of session contents.
- Exact-path reads restricted to the configured Pi sessions directory after canonical path resolution.
- Bounded Tool output and bounded result counts.

A change that expands these permissions or transmits session data requires explicit documentation and security review.
