import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

// Read cli.ts source to extract COMMAND_HELP keys and switch cases
const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf-8');

// Extract COMMAND_HELP keys from the map
function extractCommandHelpKeys(source: string): string[] {
  const mapMatch = source.match(/const COMMAND_HELP:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\};/);
  if (!mapMatch) return [];
  const keys: string[] = [];
  for (const m of mapMatch[1].matchAll(/^\s*['"]?([a-z-]+)['"]?\s*:/gm)) {
    keys.push(m[1]);
  }
  return keys.sort();
}

// Extract switch case labels from the switch(command) block
function extractSwitchCases(source: string): string[] {
  const cases: string[] = [];
  for (const m of source.matchAll(/case\s+'([^']+)':\s*\{/g)) {
    cases.push(m[1]);
  }
  return [...new Set(cases)].sort();
}

// Extract commands handled before the switch (init, upgrade)
function extractEarlyCommands(source: string): string[] {
  const cmds: string[] = [];
  for (const m of source.matchAll(/if\s*\(command\s*===\s*'([^']+)'\)/g)) {
    if (!['--help', '-h', '--version', '--tools-json'].includes(m[1])) {
      cmds.push(m[1]);
    }
  }
  return [...new Set(cmds)].sort();
}

describe('CLI COMMAND_HELP consistency', () => {
  const helpKeys = extractCommandHelpKeys(cliSource);
  const switchCases = extractSwitchCases(cliSource);
  const earlyCmds = extractEarlyCommands(cliSource);
  const allHandled = [...switchCases, ...earlyCmds].sort();

  test('COMMAND_HELP has entries for all switch cases', () => {
    for (const cmd of switchCases) {
      expect(helpKeys).toContain(cmd);
    }
  });

  test('COMMAND_HELP has entries for early-dispatch commands (init, upgrade)', () => {
    for (const cmd of earlyCmds) {
      expect(helpKeys).toContain(cmd);
    }
  });

  test('every COMMAND_HELP key maps to a handled command', () => {
    for (const key of helpKeys) {
      expect(allHandled).toContain(key);
    }
  });

  test('COMMAND_HELP has at least 25 entries', () => {
    expect(helpKeys.length).toBeGreaterThanOrEqual(25);
  });
});

describe('CLI version', () => {
  test('VERSION matches package.json', async () => {
    const { VERSION } = await import('../src/version.ts');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    expect(VERSION).toBe(pkg.version);
  });

  test('VERSION is a valid semver string', async () => {
    const { VERSION } = await import('../src/version.ts');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('CLI help text', () => {
  test('every COMMAND_HELP entry starts with Usage:', () => {
    const mapMatch = cliSource.match(/const COMMAND_HELP:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\};/);
    expect(mapMatch).not.toBeNull();
    // Verify by importing and checking
    const keys = extractCommandHelpKeys(cliSource);
    expect(keys.length).toBeGreaterThan(0);
    // Each help string in the source should contain 'Usage:'
    for (const key of keys) {
      const pattern = new RegExp(`['"]?${key.replace('-', '\\-')}['"]?:\\s*['"\`]([^'"\`]*)`);
      const match = cliSource.match(pattern);
      if (match) {
        expect(match[1]).toContain('Usage:');
      }
    }
  });
});

describe('CLI dispatch integration', () => {
  test('--version outputs version', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', '--version'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout.trim()).toMatch(/^gbrain \d+\.\d+\.\d+/);
  });

  test('unknown command prints error and exits 1', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'notacommand'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(stderr).toContain('Unknown command: notacommand');
    expect(exitCode).toBe(1);
  });

  test('per-command --help prints usage without DB connection', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'get', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: gbrain get');
    expect(exitCode).toBe(0);
  });

  test('upgrade --help prints usage without running upgrade', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'upgrade', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: gbrain upgrade');
    expect(exitCode).toBe(0);
  });

  test('init --help prints usage without running wizard', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'init', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: gbrain init');
    expect(exitCode).toBe(0);
  });

  test('--help prints global help', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('USAGE');
    expect(stdout).toContain('gbrain <command>');
    expect(exitCode).toBe(0);
  });

  test('files --help prints subcommand help', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'files', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('files list');
    expect(stdout).toContain('files upload');
    expect(exitCode).toBe(0);
  });
});
