# Maintainer notes — Dev-makeem

## #760 — deny.toml licence/bans/sources policy

Already resolved on `main`. `deny.toml` at the repo root now includes
`[licenses]` (a permissive-licence allowlist covering MIT, Apache-2.0,
BSD-2/3-Clause, ISC, Unicode-3.0, Unlicense, Zlib, plus the LLVM
exception), `[bans]` (`multiple-versions = "warn"`, `wildcards = "deny"`),
and `[sources]` (`unknown-registry = "deny"`, `unknown-git = "deny"`), in
addition to the `[advisories]` section the issue reported as the only one
present. No further change was needed for this issue.

## #763 — docs.yml external-link-check schedule trigger

Already resolved on `main`. `.github/workflows/docs.yml`'s `on:` block
already declares both a `schedule:` trigger (`cron: '0 2 * * *'`, nightly
external link check) and `workflow_dispatch:`, so the
`markdown-links-external` job's `if: github.event_name == 'schedule' || ...`
guard is reachable. No further change was needed for this issue.
