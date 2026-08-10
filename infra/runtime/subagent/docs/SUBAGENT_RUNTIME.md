# Subagent runtime

Lambda launches a real subagent with trusted job, agent, task-key, model, and
orchestrator identity in `/etc/multi-agent/subagent.env`. The launch user data
starts `multi-agent-subagent.service`; the service is disabled in the AMI so
Image Builder and unrelated boots cannot accidentally run it.

The runner downloads and validates
`jobs/<job_id>/agents/<agent_id>/input.json`, then runs Codex non-interactively
with approvals disabled. Codex has a workspace-write sandbox rooted at `/work`,
additional writable roots `/summary` and `/result`, and outbound network access.
The ordinary `/tmp` roots are excluded and `TMPDIR` is redirected to
`/work/tmp`, keeping task-generated temporary content within `/work`.

The filesystem contract is:

- `/work`: task input, code, downloads, and all working artifacts.
- `/summary/summary.md`: concise work log, methods, sources, conclusions, and
  caveats.
- `/result/result.md`: final response captured by `codex exec
  --output-last-message`.

After Codex exits, the runner requires both Markdown files to be non-empty. It
uploads the summary first, then the result, then a completion record beneath the
agent's S3 prefix. Only then does the runner exit successfully.

The systemd unit always invokes `shutdown -h now` after the runner exits. EC2's
instance-initiated shutdown behavior is `terminate`, so the instance and its
root volume are deleted. The configured TTL wraps the runner with `timeout` as
a hard billing backstop; failures and timeouts also terminate the instance, and
EventBridge reconciles the DynamoDB active count after EC2 reports termination.
