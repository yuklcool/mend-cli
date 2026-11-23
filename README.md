[![mend — make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yuklcool/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yuklcool/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

`mend` is a zero-dependency Node 22 CLI tool that applies AI-generated edits to a tree of text files according to [SPEC.md](./SPEC.md).

## Supported Formats

- **Unified diffs** (`--format=unified`): handles offset line numbers, blank context lines without leading space, prose/code fences, CRLF, `\ No newline at end of file`, creation, deletion, and rename/move.
- **SEARCH/REPLACE blocks** (`--format=search-replace`): parses fenced or bare blocks, inherits previous block path when omitted, creates files on empty search blocks, detects ambiguous matches.
- **V4A patches** (`--format=v4a`): supports `Add File`, `Delete File`, `Update File`, `Move to`, `@@ <anchor>`, cursor tracking, and `*** End of File`.
- **JSON edits** (`--format=json`): array or JSON Lines with `create`, `str_replace`, and `insert`.

## Usage

```bash
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `--format=NAME`: `auto` (default), `unified`, `search-replace`, `v4a`, or `json`.
- `--check`: validate and print summary without modifying files on disk.
- `--strict`: exact line matching only (tier 0).

## Testing

```bash
node check.ts /path/to/practice.json
```
