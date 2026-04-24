---
name: minion-orchestrator
version: 1.0.0
description: |
  Unified Minions skill for both deterministic shell jobs and LLM subagent
  orchestration. Replaces the older `gbrain-jobs` routing intent. Use when:
  submitting gbrain jobs, shell/background tasks, spawning subagents,
  checking progress, steering running work, pausing/resuming, parallel
  fan-out. One durable, observable, steerable queue interface.
triggers:
  - "gbrain jobs submit"
  - "submit a gbrain job"
  - "submit a shell job"
  - "shell job"
  - "run shell command in background"
  - "deterministic background task"
  - "spawn agent"
  - "background task"
  - "run in background"
  - "check on agent"
  - "agent progress"
  - "what's running"
  - "steer agent"
  - "change direction"
  - "tell the agent"
  - "pause agent"
  - "stop agent"
  - "resume agent"
  - "parallel tasks"
  - "fan out"
  - "do these in parallel"
tools:
  - submit_job
  - get_job
  - list_jobs
  - cancel_job
  - pause_job
  - resume_job
  - replay_job
  - send_job_message
  - get_job_progress
mutating: true
---

# Minion Orchestrator

## Contract

Minions is a Postgres-native job queue for durable, observable background work.
This single skill handles two lanes:
- Deterministic shell jobs (`gbrain jobs submit shell ...`)
- LLM subagent jobs (`gbrain agent run ...`)

When to route to Minions: durable, observable work that must survive restarts,
fan out across many parallel tasks, or persist across sessions. Routing policy
is defined in `skills/conventions/subagent-routing.md` — the project default is
`pain_triggered` (native subagents first, Minions after specific pain signals
fire); Mode A (all-through-Minions) is opt-in.

Guarantees:
- Jobs survive gateway restart (Postgres-backed)
- Every job has structured progress, token accounting, and session transcripts
- Running agents can be steered mid-flight via inbox messages
- Jobs can be paused, resumed, or cancelled at any time
- Parent-child DAGs with configurable failure policies

## Route the Request: Shell Job vs Subagent

| Condition | Action |
|---|---|
| User asks for deterministic command/script run | Shell job (CLI: `gbrain jobs submit shell ...`) |
| User asks to "run in minions" + explicit command/argv | Shell job (CLI, with `--cmd` or `--argv`) |
| User asks for research/reasoning/iterative agent | Subagent job (CLI: `gbrain agent run`) |
| User asks to steer/pause/resume an agent | Subagent job lifecycle tools (MCP-callable) |
| Single simple operation under ~30s | Consider inline execution first |
| Needs restart durability/observability | Submit as Minion job |
| Parallel work (2+ streams) | `gbrain agent run --fanout-manifest` or parent + child subagents |

If intent is ambiguous, ask one clarification:
"Do you want a deterministic shell command job, or an LLM agent job?"

## Shell Jobs (Deterministic Scripts)

Use for reproducible command execution, ETL steps, cron work, and scriptable
tasks where no LLM reasoning loop is needed.

### Preconditions (read before submitting your first shell job)

- **`GBRAIN_ALLOW_SHELL_JOBS=1` must be set on the worker environment.**
  Without it, the shell handler refuses to register and submissions sit in
  `waiting` silently. Gate lives in `src/core/minions/handlers/shell.ts`.
- **Security:** flipping `GBRAIN_ALLOW_SHELL_JOBS=1` authorizes arbitrary
  command execution on the worker. On a shared queue, this is a remote code
  execution surface. Treat as privileged infrastructure authorization.
- **Execution mode — pick one:**
  - **Postgres + daemon:** `gbrain jobs work` runs a persistent worker that
    claims and executes jobs from the queue.
  - **PGLite + --follow:** `gbrain jobs submit ... --follow` runs inline.
    The daemon mode is not available on PGLite (exclusive file lock). See
    `docs/guides/minions-shell-jobs.md`.
- **MCP boundary:** shell-job submission is CLI-only. `submit_job name="shell"`
  over MCP returns `permission_denied` because `shell` is in
  `PROTECTED_JOB_NAMES`. Agents CAN observe shell jobs via `get_job` /
  `list_jobs` / `get_job_progress` (not protected), but cannot submit them.
  Operator or autopilot submits; agent observes.
- **Verify setup:** after configuration, run `gbrain jobs stats` (CLI) to
  confirm the worker is registered and consuming the queue.

### Submit (CLI, operator or autopilot)

Command string form:
```
gbrain jobs submit shell --cmd "echo hello" --cwd /abs/path
```

Argv form (no shell expansion):
```
gbrain jobs submit shell --argv '["bash","-lc","echo hello"]' --cwd /abs/path
```

Inline execution on PGLite or any one-shot deployment:
```
gbrain jobs submit shell --cmd "echo hello" --follow
```

Queue/lifecycle flags (`--queue`, `--priority`, `--max-attempts`, `--delay`,
`--timeout-ms`, `--backoff-type`, `--backoff-delay`, `--idempotency-key`)
all work; see `gbrain jobs submit --help`.

### Monitor (agents or operator)

These operations are MCP-callable and safe for agent use:

```
list_jobs --name shell --status active
get_job ID
get_job_progress ID
```

Check structured result fields (exit code, stdout/stderr tails, attempts,
timings) from `get_job`. Use `gbrain jobs stats` (CLI) for worker/queue
health dashboard.

### Control (MCP-callable)

```
cancel_job id=ID
replay_job id=ID
```

`replay_job` is not protected — only shell *submission* is. Agents can
cancel or replay a shell job without CLI access.

Use idempotency keys for recurring shell workloads to avoid duplicate runs.

## Subagent Jobs (LLM Orchestration)

Use for open-ended reasoning, tool-using research, and fan-out synthesis.

**User-facing entrypoint:** `gbrain agent run <prompt>` is the canonical way
to submit subagent work. It handles the elevated-trust plumbing — `subagent`
and `subagent_aggregator` are both in `PROTECTED_JOB_NAMES`, so direct MCP
submission requires `{allowProtectedSubmit: true}`, which `gbrain agent run`
supplies.

## Phase 1: Submit

```
gbrain agent run "Research Acme Corp revenue" --tools "search,web_search"
```

For parallel work with a fan-out manifest:
```
gbrain agent run --fanout-manifest companies.json
```

The manifest describes N children + 1 aggregator. Each child runs
`name="subagent"` under the hood; the aggregator runs `name="subagent_aggregator"`
and claims AFTER every child terminates. See
`src/core/minions/handlers/subagent.ts` and
`src/core/minions/handlers/subagent-aggregator.ts`.

Flags:
- `--queue` — queue name (default: 'default')
- `--priority` — lower = higher priority (default: 0)
- `--max-attempts` — retry limit (default: 3)
- `--delay` — ms delay before eligible
- `--follow` — stream logs + wait for completion (default on TTY)

## Phase 2: Monitor

```
list_jobs --status active          # MCP — what's running?
get_job ID                         # MCP — full details + logs + tokens
get_job_progress ID                # MCP — structured progress snapshot
gbrain jobs stats                  # CLI — queue health dashboard
gbrain agent logs ID --follow      # CLI — streaming transcript + heartbeat
```

Progress includes: step count, total steps, message, token usage, last tool called.

## Phase 3: Steer

Send a message to redirect a running agent:
```
send_job_message id=ID payload={"directive":"focus on revenue, skip headcount"}
```

The agent handler reads inbox messages on each iteration and injects them as
context. Messages are acknowledged (read receipts tracked).

Only the parent job or admin can send messages (sender validation).

## Phase 4: Lifecycle

```
pause_job id=ID                    # freeze without losing state
resume_job id=ID                   # pick up where it left off
cancel_job id=ID                   # hard stop
replay_job id=ID                   # re-run with same or modified params
replay_job id=ID data_overrides={"depth":"deep"}  # replay with changes
```

All lifecycle ops are MCP-callable.

## Phase 5: Review Results

```
get_job ID                         # result, token counts, transcript
```

Token accounting: every job tracks `tokens_input`, `tokens_output`, `tokens_cache_read`.
Child tokens roll up to parent automatically on completion.

## Output Format

When reporting job status to the user:

```
Job #ID (name) — status
Progress: step/total — last action
Tokens: input_count in / output_count out (+ cache_read cached)
Runtime: Xs
Children: N pending, M completed
```

When reporting completion:

```
Job #ID completed in Xs
Tokens used: input / output / cache_read
Result: <summary>
```

When reporting batch status (parent with children):

```
Parent #ID — waiting-children
  #A subagent(Acme) — active, 3/5 steps, 2.5k tokens
  #B subagent(Beta) — completed, 1.8k tokens
  #C subagent(Gamma) — paused
Total tokens so far: 4.3k
```

## Anti-Patterns

- Don't spawn a Minion for a single search query (use search tool directly)
- Don't fire-and-forget without checking results
- Don't spawn > 5 concurrent agents without checking `gbrain jobs stats` first
- Don't use `sessions_spawn` with `runtime: "subagent"` when Minions is available
- Don't poll `get_job` in a tight loop (use `get_job_progress` for lightweight checks)

## Tools Used

- Submit a background job — `submit_job` (MCP, non-protected names only; shell jobs are CLI-only, subagent jobs via `gbrain agent run`)
- Get job details — `get_job` (MCP)
- List jobs with filters — `list_jobs` (MCP)
- Cancel a job — `cancel_job` (MCP)
- Pause a job — `pause_job` (MCP)
- Resume a paused job — `resume_job` (MCP)
- Replay a completed/failed job — `replay_job` (MCP)
- Send sidechannel message — `send_job_message` (MCP)
- Get structured progress — `get_job_progress` (MCP)
- Queue stats — `gbrain jobs stats` (CLI; no MCP equivalent)
