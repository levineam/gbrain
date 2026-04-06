import { execSync } from 'child_process';

export async function runUpgrade(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: gbrain upgrade\n\nSelf-update the CLI.\n\nDetects install method (bun, binary, clawhub) and runs the appropriate update.');
    return;
  }

  const method = detectInstallMethod();

  console.log(`Detected install method: ${method}`);

  switch (method) {
    case 'bun':
      console.log('Upgrading via bun...');
      try {
        execSync('bun update gbrain', { stdio: 'inherit', timeout: 120_000 });
        console.log('Upgrade complete.');
      } catch {
        console.error('Upgrade failed. Try running manually: bun update gbrain');
      }
      break;

    case 'binary':
      console.log('Binary self-update not yet implemented.');
      console.log('Download the latest binary from GitHub Releases:');
      console.log('  https://github.com/garrytan/gbrain/releases');
      break;

    case 'clawhub':
      console.log('Upgrading via ClawHub...');
      try {
        execSync('clawhub update gbrain', { stdio: 'inherit', timeout: 120_000 });
        console.log('Upgrade complete.');
      } catch {
        console.error('ClawHub upgrade failed. Try: clawhub update gbrain');
      }
      break;

    default:
      console.error('Could not detect installation method.');
      console.log('Try one of:');
      console.log('  bun update gbrain');
      console.log('  clawhub update gbrain');
      console.log('  Download from https://github.com/garrytan/gbrain/releases');
  }
}

function detectInstallMethod(): 'bun' | 'binary' | 'clawhub' | 'unknown' {
  const execPath = process.execPath || '';

  // Check if running from node_modules (bun/npm install)
  if (execPath.includes('node_modules') || process.argv[1]?.includes('node_modules')) {
    return 'bun';
  }

  // Check if running as compiled binary
  if (execPath.endsWith('/gbrain') || execPath.endsWith('\\gbrain.exe')) {
    return 'binary';
  }

  // Check if clawhub is available (use --version, not which, to avoid false positives)
  try {
    execSync('clawhub --version', { stdio: 'pipe', timeout: 5_000 });
    return 'clawhub';
  } catch {
    // not available
  }

  return 'unknown';
}
