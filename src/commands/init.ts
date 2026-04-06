import { execSync } from 'child_process';
import { PostgresEngine } from '../core/postgres-engine.ts';
import { saveConfig, type GBrainConfig } from '../core/config.ts';

export async function runInit(args: string[]) {
  const isSupabase = args.includes('--supabase');
  const urlIndex = args.indexOf('--url');
  const manualUrl = urlIndex !== -1 ? args[urlIndex + 1] : null;

  let databaseUrl: string;

  if (manualUrl) {
    databaseUrl = manualUrl;
  } else if (isSupabase) {
    databaseUrl = await supabaseWizard();
  } else {
    // Default to supabase wizard
    databaseUrl = await supabaseWizard();
  }

  // Connect and init schema
  console.log('Connecting to database...');
  const engine = new PostgresEngine();
  await engine.connect({ database_url: databaseUrl });

  console.log('Running schema migration...');
  await engine.initSchema();

  // Save config
  const config: GBrainConfig = {
    engine: 'postgres',
    database_url: databaseUrl,
  };
  saveConfig(config);
  console.log('Config saved to ~/.gbrain/config.json');

  // Verify
  const stats = await engine.getStats();
  await engine.disconnect();

  console.log(`\nBrain ready. ${stats.page_count} pages.`);
  console.log('Next: gbrain import <dir> to migrate your markdown.');
}

async function supabaseWizard(): Promise<string> {
  // Try Supabase CLI auto-provision
  try {
    execSync('bunx supabase --version', { stdio: 'pipe' });
    console.log('Supabase CLI detected.');
    console.log('To auto-provision, run: bunx supabase login && bunx supabase projects create');
    console.log('Then use: gbrain init --url <your-connection-string>');
  } catch {
    console.log('Supabase CLI not found.');
    console.log('Install it: bun add -g supabase');
    console.log('Or provide a connection URL directly.');
  }

  // Fallback to manual URL
  console.log('\nEnter your Supabase/Postgres connection URL:');
  console.log('  Format: postgresql://user:password@host:port/database');
  console.log('  Find it: Supabase Dashboard > Settings > Database > Connection string\n');

  const url = await readLine('Connection URL: ');
  if (!url) {
    console.error('No URL provided.');
    process.exit(1);
  }
  return url;
}

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', (chunk) => {
      data = chunk.toString().trim();
      resolve(data);
    });
    process.stdin.resume();
  });
}
