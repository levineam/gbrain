import { readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import type { BrainEngine } from './engine.ts';
import { parseMarkdown } from './markdown.ts';
import { chunkText } from './chunkers/recursive.ts';
import { embedBatch } from './embedding.ts';
import type { ChunkInput } from './types.ts';

export interface ImportFileResult {
  slug: string;
  status: 'imported' | 'skipped' | 'error';
  chunks: number;
  error?: string;
}

const MAX_FILE_SIZE = 1_000_000; // 1MB

export async function importFile(
  engine: BrainEngine,
  filePath: string,
  relativePath: string,
  opts: { noEmbed: boolean },
): Promise<ImportFileResult> {
  // Skip files > 1MB
  const stat = statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    return { slug: relativePath, status: 'skipped', chunks: 0, error: `File too large (${stat.size} bytes)` };
  }

  const content = readFileSync(filePath, 'utf-8');
  const parsed = parseMarkdown(content, relativePath);
  const slug = parsed.slug;

  // Check content hash for idempotency
  const hash = createHash('sha256')
    .update(parsed.compiled_truth + '\n---\n' + parsed.timeline)
    .digest('hex');

  const existing = await engine.getPage(slug);
  if (existing?.content_hash === hash) {
    return { slug, status: 'skipped', chunks: 0 };
  }

  // Upsert page
  await engine.putPage(slug, {
    type: parsed.type,
    title: parsed.title,
    compiled_truth: parsed.compiled_truth,
    timeline: parsed.timeline,
    frontmatter: parsed.frontmatter,
  });

  // Tag reconciliation: remove stale tags, add current ones
  const existingTags = await engine.getTags(slug);
  const newTags = new Set(parsed.tags);
  for (const oldTag of existingTags) {
    if (!newTags.has(oldTag)) {
      await engine.removeTag(slug, oldTag);
    }
  }
  for (const tag of parsed.tags) {
    await engine.addTag(slug, tag);
  }

  // Chunk compiled_truth and timeline
  const chunks: ChunkInput[] = [];

  if (parsed.compiled_truth.trim()) {
    const ctChunks = chunkText(parsed.compiled_truth);
    for (const c of ctChunks) {
      chunks.push({
        chunk_index: chunks.length,
        chunk_text: c.text,
        chunk_source: 'compiled_truth',
      });
    }
  }

  if (parsed.timeline.trim()) {
    const tlChunks = chunkText(parsed.timeline);
    for (const c of tlChunks) {
      chunks.push({
        chunk_index: chunks.length,
        chunk_text: c.text,
        chunk_source: 'timeline',
      });
    }
  }

  // Embed if requested
  if (!opts.noEmbed && chunks.length > 0) {
    try {
      const embeddings = await embedBatch(chunks.map(c => c.chunk_text));
      for (let j = 0; j < chunks.length; j++) {
        chunks[j].embedding = embeddings[j];
        chunks[j].token_count = Math.ceil(chunks[j].chunk_text.length / 4);
      }
    } catch {
      // Embedding failure is non-fatal, chunks still saved without embeddings
    }
  }

  if (chunks.length > 0) {
    await engine.upsertChunks(slug, chunks);
  }

  return { slug, status: 'imported', chunks: chunks.length };
}
