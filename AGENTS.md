# Repository instructions

## Development stage and compatibility

- This project is in rapid iteration. By default, implement features only for
  the current schema, runtime, and UI behavior.
- Do not add backward-compatibility branches, legacy fallbacks, dual reads or
  writes, adapters, backfills, or data migrations unless the user explicitly
  requests them for the current task.
- Prefer removing superseded code paths over preserving them. Existing saved
  jobs and records may be incompatible with a new feature during this stage.
- If a requested change would ordinarily require compatibility work, mention
  the consequence briefly, but do not implement that work without approval.
