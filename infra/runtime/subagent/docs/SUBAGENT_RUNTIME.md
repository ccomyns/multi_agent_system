# Subagent runtime

Lambda launches a real subagent with trusted job, agent, task-key, model, and
orchestrator identity in `/etc/multi-agent/subagent.env`. The launch user data
starts `multi-agent-subagent.service`; the service is disabled in the AMI so
Image Builder and unrelated boots cannot accidentally run it.

The runner downloads and validates
`jobs/<job_id>/agents/<agent_id>/input.json`, then runs Codex non-interactively
with approvals disabled. Codex has a workspace-write sandbox rooted at `/work`,
an additional writable root at `/summary`, and outbound network access. Only the
supervisor writes `/result`. The ordinary `/tmp` roots are excluded and
`TMPDIR` is redirected to `/work/tmp`, keeping task-generated temporary content
within `/work`.

The filesystem contract is:

- `/work`: task input, code, downloads, and all working artifacts.
- `/summary/summary.md`: approach, methods, sources, significant findings,
  useful work artifacts, and caveats.
- `/summary/results_<agent_id>.json`: the gathered data as a structured JSON
  object or array.
- `/result/completed.md` or `/result/failure.md`: a brief terminal marker
  written by the supervisor, not a research output.

After Codex exits, the runner requires a non-empty summary and a non-empty,
valid JSON dataset. It uploads those files first, then writes and uploads
`status/completed.json`, and finally writes and uploads `completed.md` as the
terminal readiness flag. If execution or publication fails, it publishes
`status/failed.json` and then `failure.md` when possible. The terminal marker is
the last publication step; the runner exits immediately afterward.

The systemd unit always invokes `shutdown -h now` after the runner exits. EC2's
instance-initiated shutdown behavior is `terminate`, so the instance and its
root volume are deleted. The configured TTL wraps the runner with `timeout` as
a hard billing backstop; failures and timeouts also terminate the instance, and
EventBridge reconciles the DynamoDB active count after EC2 reports termination.
