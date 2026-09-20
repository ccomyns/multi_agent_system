# Software-builder conversation lifecycle

The software-builder runner launches `codex app-server` over stdio. It initializes
the connection, creates one non-ephemeral thread, and starts the original task.
The existing Codex authentication, repository scope, database credentials, and
Vercel MCP configuration remain in use. Research runtimes still use `codex exec`.

## Single-turn and continuous work

- `/software` submits `reprompt` alongside `originalTask`; the launch API validates
  it (up to 4,000 characters) and stores it on the job record. Missing, null, empty,
  or whitespace-only REPROMPT is stored as null and selects single-turn mode.
- Without REPROMPT, turns continue with active-agent context while any agents
  remain active. Once none are active, the runner closes delegation. Uncollected
  outcomes trigger one final integration turn on the same thread. With no
  uncollected outcomes, the last ordinary turn's response is final. Initial turn
  failures fail the job; active-agent coordination can retry, and final integration
  retries are bounded to three attempts.
- A non-empty REPROMPT selects continuous mode. After every successful ordinary
  turn, the runner checks active subagent reservations. If any remain, it starts
  another turn with their count, IDs, tasks, statuses and S3 output locations,
  without adding REPROMPT. If none remain, it supplies continuation instructions,
  the original goal and REPROMPT. Provisioning reservations count as active;
  completed/inactive agents are omitted from the active inventory.
- Reconnecting to a saved thread refreshes this inventory before choosing the
  next ordinary prompt. A failed status request is not treated as zero active
  agents. End Job always takes priority over both normal continuation modes.
- In continuous mode, app-server stays alive between turns. Failed turns and process exits
  restart the connection and resume the exact saved thread, with retry delays up
  to 60 seconds. The runner never substitutes a new conversation if resume fails.
- Thread identity and the permanent end flag are written atomically to
  `/var/lib/multi-agent/software-jobs/<job-id>/codex-conversation.json`.
  Codex stores its rollout in `/var/lib/multi-agent/software-codex-home`.
  Context therefore survives app-server process restarts on the same worker.
  Normal Codex compaction still applies; machine/disk loss and unsaved in-memory
  state are not recoverable. A thread must receive its first input before Codex
  creates its resumable rollout.
- The runner owns the continuation loop. The shell/systemd bootstrap should not
  start a second loop around it or relaunch it after final completion.

## End Job

An explicit End Job request still interrupts and starts a final wrap-up turn in
either mode. Single-turn jobs do not need an End Job request to finish naturally.

For software jobs, `DELETE /api/jobs?jobId=...` idempotently records
`end_requested_at`. It returns 202 for a new request, keeps the active-job lock,
and keeps the job running so credential refresh and publication remain allowed.
Requests during initialization are retained for the runner to observe.

The runner polls the job every two seconds while waiting for events, and before
dispatching each turn. RPC handshakes and AWS calls can delay observation. Once
observed, ending is persisted locally and normal continuation is disabled:

1. Request `turn/interrupt` for any ordinary turn still running.
2. Close delegation atomically against launches, drain all reserved subagents,
   and start a dedicated final turn on the same thread with their outcomes.
3. Instruct Codex to launch no more subagents, stop expanding scope, validate,
   commit, push, and publish applicable website changes to Vercel. Explicit user
   instructions against deployment still apply. The manager rejects further launches.
4. Save the final agent message and exit both the turn loop and app-server process.
5. Run the existing clean-tree/remote-commit validation, upload results, mark the
   job completed, and release the lock. The systemd exit hook shuts down the
   instance, whose launch template terminates it on shutdown.

Wrap-up failures can reconnect to the same thread for up to three attempts, always
with wrap-up instructions. Exhausting these attempts marks the job failed through
the runner's failure path; it cannot restart ordinary work. Repository validation
failures also mark the job failed. Codex reports deployment outcomes in its final
message, and the publisher records successful deployments on the job.

The monitor displays **Wrapping up…** and disables repeated end requests while
the worker finishes. Data-mining end-job behavior is unchanged.

## Observability and verification

App-server notifications are logged as JSONL. `thread/tokenUsage/updated` supplies
cumulative root-thread totals; telemetry replaces the totals rather than adding
each notification. Turn, restart, and wrap-up checkpoints appear in the existing
orchestrator telemetry view.

Run from the repository root:

```sh
.venv/bin/python -m unittest discover -s infra/tests
```

Run from `admin`:

```sh
node --test tests/software-job-control.test.mjs
npm run typecheck
```

Deploy the updated admin app and software runtime archive through the existing
deployment flow. The archive is installed at instance launch, so this change is
for newly launched jobs; an existing worker is not updated in place. No migration
or compatibility path for old software jobs is included.

Protocol reference: https://learn.chatgpt.com/docs/app-server

## Research agents

The software MCP exposes `spawn_agent(task)` and `wait_on_any(agent_ids,
timeout_seconds)`. The manager reads the immutable project assignment and caps
active reservations at 12. Each agent gets a separate EC2 role whose S3 access
is confined to `<project>/<agent>/` in the actual global-memory bucket. Agents
have no application GitHub, database, or publishing credentials. They choose their
JSON structures for their gathered data, upload it as `.json` files to their
assigned S3 folder, and document those files in `description.md`; the separate software worker
runtime resumes Codex until this file is valid or the total 30-minute deadline
expires. See the root README for storage, cleanup and deployment details.
