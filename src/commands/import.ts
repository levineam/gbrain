import { readdirSync, statSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, relative } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { importFile } from '../core/import-file.ts';

export async function runImport(engine: BrainEngine, args: string[]) {
  const dir = args.find(a => !a.startsWith('--'));
  const noEmbed = args.includes('--no-embed');

  if (!dir) {
    console.error('Usage: gbrain import <dir> [--no-embed]');
    process.exit(1);
  }

  // Collect all .md files
  const files = collectMarkdownFiles(dir);
  console.log(`Found ${files.length} markdown files`);

  let imported = 0;
  let skipped = 0;
  let chunksCreated = 0;
  const importedSlugs: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const relativePath = relative(dir, filePath);

    // Progress
    if ((i + 1) % 100 === 0 || i === files.length - 1) {
      process.stdout.write(`\r  ${i + 1}/${files.length} files processed, ${imported} imported, ${skipped} skipped`);
    }

    try {
      const result = await importFile(engine, filePath, relativePath, { noEmbed });
      if (result.status === 'imported') {
        imported++;
        chunksCreated += result.chunks;
        importedSlugs.push(result.slug);
      } else {
        skipped++;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`\n  Warning: skipped ${relativePath}: ${msg}`);
      skipped++;
    }
  }

  console.log(`\n\nImport complete:`);
  console.log(`  ${imported} pages imported`);
  console.log(`  ${skipped} pages skipped (unchanged or error)`);
  console.log(`  ${chunksCreated} chunks created`);

  // Log the ingest
  await engine.logIngest({
    source_type: 'directory',
    source_ref: dir,
    pages_updated: importedSlugs,
    summary: `Imported ${imported} pages, ${skipped} skipped, ${chunksCreated} chunks`,
  });

  // Import → sync continuity: write sync checkpoint if this is a git repo
  try {
    if (existsSync(join(dir, '.git'))) {
      const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      await engine.setConfig('sync.last_commit', head);
      await engine.setConfig('sync.last_run', new Date().toISOString());
      await engine.setConfig('sync.repo_path', dir);
    }
  } catch {
    // Not a git repo or git not available, skip checkpoint
  }
}

function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      // Skip hidden dirs and .raw dirs
      if (entry.startsWith('.')) continue;

      const full = join(d, entry);
      const stat = statSync(full);

      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.md')) {
        files.push(full);
      }
    }
  }

  walk(dir);
  return files.sort();
}
