# ompconfig

Private source repository for personal OMP and Claude agent configuration.

## Tracked

- `omp/agent/config.yml`: portable OMP settings and skill allowlist
- `claude/CLAUDE.md`: global agent instructions
- `skills/`: personally maintained skills
- `plugins/manifest.yml`: third-party marketplace/plugin declarations
- `scripts/`: install, sync, and verification commands
- Matt Pocock Chinese bundle: all 35 upstream skills are vendored; `ask-matt`, `grilling`, and `prototype` contain personal overrides

Runtime databases, sessions, memories, caches, credentials, and machine-local MCP paths are intentionally excluded.

## Install on a machine

```bash
./scripts/install.sh
```

Existing configuration files are copied to timestamped backups before replacement. Installation restores every vendored Skill directly, so the Matt Pocock bundle does not depend on upstream network access. Third-party plugin installation remains best-effort because it requires network access.

## Capture local changes

```bash
./scripts/sync-from-home.sh
./scripts/verify.sh
git diff
```

Commit only after reviewing the diff.

## Update another machine

```bash
git pull --ff-only
./scripts/install.sh
```

## Scope rule

Keep cross-project preferences here. Put project-specific instructions, MCP servers, and skills in that project's `.omp/` directory.
