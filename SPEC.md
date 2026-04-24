# Queue Resilience — Preventing Stall-Induced Queue Blockage

## Problem Statement

In production (OpenClaw + gbrain), the Minions job queue experienced a full blockage:
1. A single `autopilot-cycle` job stalled (git index.lock held the process)
2. The stall detector (`handleStalled`) uses `FOR UPDATE SKIP LOCKED`, so when the stalled process still held a DB connection, the detector skipped it every tick — the stall counter never incremented
3. With worker concurrency=1, this one un-evictable job blocked the entire queue for 90+ minutes
4. Meanwhile, the autopilot cron kept submitting new `autopilot-cycle` jobs every 5 minutes (18 duplicate slots piled up)
5. Shell jobs (X ingestion pipeline) starved completely — 28 jobs queued but never ran

Additionally, the `autopilot` command spawns its own worker via `spawn('gbrain', ['jobs', 'work'])` with no flags, creating conflicts when an external orchestrator (OpenClaw service-manager) already manages a properly-configured worker (concurrency=4, GBRAIN_ALLOW_SHELL_JOBS=1).

## Changes Required

### 1. Wall-clock timeout in stall detector (`src/core/minions/queue.ts`)

**In `handleStalled()`:** After the existing lock-based stall detection, add a secondary sweep that checks `started_at` wall-clock time. If a job has been in `status='active'` for longer than `timeout_ms` (or `2 × lock_duration × max_stalled` as fallback when no timeout_ms is set), force-fail it regardless of lock state. This catches jobs where the process holds a DB connection but is stuck (e.g., waiting on a file lock).

Implementation: Add a new method `handleWallClockTimeouts()` or extend `handleTimeouts()`. The key difference from existing `handleTimeouts()`: the existing one requires `lock_until > now()` (lock still held). The new check should work when `lock_until` has expired BUT the stall detector's `FOR UPDATE SKIP LOCKED` keeps skipping the row.

Use a simple UPDATE without `FOR UPDATE SKIP LOCKED`:
```sql
UPDATE minion_jobs 
SET status = 'dead', error_text = 'wall-clock timeout exceeded', updated_at = now()
WHERE status = 'active' 
  AND started_at < now() - interval '...'
  AND (timeout_ms IS NOT NULL AND EXTRACT(EPOCH FROM (now() - started_at)) * 1000 > timeout_ms * 2)
```

### 2. Submission-time backpressure for named jobs (`src/core/minions/queue.ts`)

**In `MinionQueue.add()`:** Add an optional `maxWaiting` field to `MinionJobInput`. When set, before inserting, count waiting jobs with the same `name`. If count >= `maxWaiting`, skip insertion and return the most recent existing waiting job instead (similar to idempotency_key behavior).

This prevents autopilot-cycle flood: even without idempotency keys, `maxWaiting: 2` means at most 2 autopilot-cycle jobs can queue up.

### 3. `--no-worker` flag for autopilot (`src/commands/autopilot.ts`)

Add a `--no-worker` CLI flag. When set, the autopilot daemon runs its submission loop but does NOT spawn a child `gbrain jobs work` process. This is for environments where the worker is managed externally (systemd, Docker, OpenClaw service-manager).

The flag should be simple: skip the `startWorker()` call block when `--no-worker` is present.

### 4. Env-based concurrency for worker (`src/commands/jobs.ts`)

In the `jobs work` command handler, read `GBRAIN_WORKER_CONCURRENCY` env var as a fallback when `--concurrency` is not passed on the CLI:

```typescript
const concurrency = parseInt(
  parseFlag(args, '--concurrency') 
  ?? process.env.GBRAIN_WORKER_CONCURRENCY 
  ?? '1', 
  10
);
```

### 5. Shell job env guard logging (`src/core/minions/handlers/shell.ts`)

When a `shell` job is claimed but `GBRAIN_ALLOW_SHELL_JOBS` is not set, log a clear warning before rejecting:
```
[shell] Job #N rejected: GBRAIN_ALLOW_SHELL_JOBS=1 not set on this worker. 
        Shell jobs require the env var on the worker process.
```

Currently it throws an error, but the error message doesn't surface clearly in queue stats.

## Testing

- Add a test for wall-clock timeout: submit a job, simulate stall (don't complete it, let lock expire), verify `handleWallClockTimeouts()` kills it
- Add a test for `maxWaiting` backpressure: submit 3 jobs with `maxWaiting: 2`, verify the 3rd returns existing job
- Add a test for `--no-worker` flag: verify autopilot runs without spawning child process
- Add a test for env-based concurrency: set `GBRAIN_WORKER_CONCURRENCY=4`, verify worker starts with concurrency 4

## Files to Modify

1. `src/core/minions/queue.ts` — wall-clock timeout + maxWaiting backpressure
2. `src/core/minions/worker.ts` — call wall-clock timeout in stall interval
3. `src/core/minions/types.ts` — add `maxWaiting` to `MinionJobInput`
4. `src/commands/autopilot.ts` — `--no-worker` flag
5. `src/commands/jobs.ts` — env-based concurrency fallback
6. `src/core/minions/handlers/shell.ts` — better rejection logging
7. Tests for all of the above

## Non-Goals

- Changing the default `max_stalled` value (5 is fine)
- Changing the `FOR UPDATE SKIP LOCKED` pattern (it's correct for normal operation)
- Adding Redis or any external dependency
- Changing the job table schema (all changes are code-only)
