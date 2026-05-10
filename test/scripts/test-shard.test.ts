/**
 * Regression test: scripts/test-shard.sh (the CI test-sharding script)
 * MUST exclude *.serial.test.ts and *.slow.test.ts files, mirroring the
 * exclusion in scripts/run-unit-shard.sh (the local fast-loop equivalent).
 *
 * Why this regression test exists: serial files use `mock.module()` which
 * leaks across files in the same `bun test` process. When test-shard.sh
 * included serial files alongside other tests in the same shard, mocks from
 * eval-takes-quality-runner.serial.test.ts leaked into voyage-multimodal.test.ts
 * and broke 18 of its 22 tests in CI shard 2 — even though local runs (which
 * already excluded serial files via run-unit-shard.sh) were green.
 *
 * Without this guard, a future refactor that drops the `-not -name '*.serial.test.ts'`
 * clause from test-shard.sh would silently re-introduce the cross-file mock
 * leak in CI without any local repro.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const TEST_SHARD_SH = resolve(REPO_ROOT, 'scripts/test-shard.sh');

describe('scripts/test-shard.sh exclusion contract', () => {
  it('excludes *.serial.test.ts files from the shard', () => {
    const source = readFileSync(TEST_SHARD_SH, 'utf-8');
    expect(source).toMatch(/-not -name ['"]\*\.serial\.test\.ts['"]/);
  });

  it('excludes *.slow.test.ts files from the shard', () => {
    const source = readFileSync(TEST_SHARD_SH, 'utf-8');
    expect(source).toMatch(/-not -name ['"]\*\.slow\.test\.ts['"]/);
  });

  it('excludes test/e2e/* (always-on contract)', () => {
    const source = readFileSync(TEST_SHARD_SH, 'utf-8');
    expect(source).toMatch(/-not -path ['"]test\/e2e\/\*['"]/);
  });
});
