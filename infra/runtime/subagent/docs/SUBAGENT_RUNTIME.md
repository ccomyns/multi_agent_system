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
- `/summary/results.json`: the gathered data as a structured JSON object or
  array. The model never has to reproduce its opaque agent ID.
- `/result/completed.md` or `/result/failure.md`: a brief terminal marker
  written by the supervisor, not a research output.

After Codex exits, the runner requires a non-empty summary and a non-empty,
valid JSON dataset. Trusted runner code maps local `/summary/results.json` to
`jobs/<job_id>/agents/<agent_id>/summary/results_<agent_id>.json`; the agent ID
comes from the validated launch environment rather than model output. It uploads
the canonical data files first, then writes and uploads `status/completed.json`,
and writes and uploads `completed.md` as the terminal readiness flag. After that
marker is durable, trusted runner code writes `termination/request.json`; an S3
notification invokes the dedicated terminator Lambda, which validates the
terminal artifacts and DynamoDB identity before requesting termination of the
exact subagent EC2 instance.
Unexpected files from `/summary` are retained only beneath
`debug/model-summary/`, never in the canonical `summary/` prefix. If execution
or publication fails, the runner publishes `status/failed.json` and then
`failure.md` and a termination request when possible. The request is control-plane
signaling rather than a research artifact, and never precedes the terminal marker.

The systemd unit still invokes `shutdown -h now` after the runner exits, and the
configured TTL still wraps the runner with `timeout`. These are independent
fallbacks if the termination-request upload or notification path is unavailable.
EC2 termination deletes the instance and root volume; EventBridge reconciles the
DynamoDB active count only after EC2 reports confirmed termination.
