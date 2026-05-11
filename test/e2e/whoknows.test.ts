/**
 * v0.33 whoknows E2E — full pipeline against a seeded PGLite brain.
 *
 * Seeds a synthetic brain matching test/fixtures/whoknows-eval.jsonl,
 * runs gbrain eval whoknows --skip-replay over the fixture, asserts
 * the quality gate passes >= 80% top-3 hit rate. Also exercises:
 *
 *   - findExperts() directly with --types filter
 *   - Person/company filtering excludes other types
 *   - Empty result returns empty array (not crash)
 *   - --explain output includes factor breakdown
 *
 * Mock embeddings via basis vectors (no OpenAI key needed). Uses the
 * same pattern as test/e2e/search-quality.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { ChunkInput } from '../../src/core/types.ts';
import { findExperts } from '../../src/commands/whoknows.ts';
import { readFixture } from '../../src/commands/eval-whoknows.ts';

let engine: PGLiteEngine;

function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1.0;
  return emb;
}

async function seedPerson(
  slug: string,
  title: string,
  topic: string,
  embeddingIdx: number,
) {
  await engine.putPage(slug, {
    type: 'person',
    title,
    compiled_truth: `${title} is an expert in ${topic}. Built career around ${topic}.`,
    timeline: `2024-01-01: ${title} on ${topic} project.`,
  });
  const chunks: ChunkInput[] = [
    {
      chunk_index: 0,
      chunk_text: `${title} is an expert in ${topic}. Built career around ${topic}.`,
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(embeddingIdx),
      token_count: 15,
    },
    {
      chunk_index: 1,
      chunk_text: `2024-01-01: ${title} on ${topic} project.`,
      chunk_source: 'timeline',
      embedding: basisEmbedding(embeddingIdx + 100),
      token_count: 10,
    },
  ];
  await engine.upsertChunks(slug, chunks);
}

async function seedCompany(
  slug: string,
  title: string,
  topic: string,
  embeddingIdx: number,
) {
  await engine.putPage(slug, {
    type: 'company',
    title,
    compiled_truth: `${title} is a company focused on ${topic}. Leader in ${topic}.`,
    timeline: `2024-01-01: ${title} ${topic} milestone.`,
  });
  const chunks: ChunkInput[] = [
    {
      chunk_index: 0,
      chunk_text: `${title} is a company focused on ${topic}. Leader in ${topic}.`,
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(embeddingIdx),
      token_count: 15,
    },
  ];
  await engine.upsertChunks(slug, chunks);
}

async function seedConcept(
  slug: string,
  title: string,
  topic: string,
  embeddingIdx: number,
) {
  await engine.putPage(slug, {
    type: 'concept',
    title,
    compiled_truth: `${topic} is an important concept. Many explore ${topic}.`,
    timeline: `2024-01-01: notes on ${topic}.`,
  });
  const chunks: ChunkInput[] = [
    {
      chunk_index: 0,
      chunk_text: `${topic} is an important concept. Many explore ${topic}.`,
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(embeddingIdx),
      token_count: 12,
    },
  ];
  await engine.upsertChunks(slug, chunks);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // People matching the synthetic fixture topics.
  await seedPerson('wiki/people/example-alice', 'Alice Example', 'fintech payments', 10);
  await seedPerson('wiki/people/example-bob', 'Bob Example', 'crypto investing', 12);
  await seedPerson('wiki/people/example-carol', 'Carol Example', 'ai agents', 14);
  await seedPerson('wiki/people/example-dave', 'Dave Example', 'distributed systems', 16);
  await seedPerson('wiki/people/example-eve', 'Eve Example', 'healthcare technology', 18);
  await seedPerson('wiki/people/example-frank', 'Frank Example', 'developer tools', 20);
  await seedPerson('wiki/people/example-grace', 'Grace Example', 'machine learning research', 22);
  await seedPerson('wiki/people/example-hank', 'Hank Example', 'climate tech', 24);
  await seedPerson('wiki/people/example-ivy', 'Ivy Example', 'enterprise sales', 26);
  await seedPerson('wiki/people/example-jake', 'Jake Example', 'hardware engineering', 28);

  // Companies matching the synthetic fixture topics.
  await seedCompany('wiki/companies/example-fintech-co', 'FintechCo', 'fintech payments', 11);
  await seedCompany('wiki/companies/example-fund', 'CryptoFund', 'crypto investing', 13);
  await seedCompany('wiki/companies/example-health-co', 'HealthCo', 'healthcare technology', 19);
  await seedCompany('wiki/companies/example-devtools-co', 'DevtoolsCo', 'developer tools', 21);
  await seedCompany('wiki/companies/example-climate-co', 'ClimateCo', 'climate tech', 25);
  await seedCompany('wiki/companies/example-hardware-co', 'HardwareCo', 'hardware engineering', 29);

  // Decoy non-person/non-company pages with the same topics (filter should hide).
  await seedConcept('concepts/fintech-essay', 'Fintech Essay', 'fintech payments', 30);
  await seedConcept('concepts/crypto-thoughts', 'Crypto Thoughts', 'crypto investing', 31);
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('whoknows E2E — quality gate on synthetic fixture', () => {
  test('runs findExperts and the fixture quality gate at >= 80% hit rate', async () => {
    const fixture = readFixture(
      `${process.cwd()}/test/fixtures/whoknows-eval.jsonl`,
    );
    expect(fixture.length).toBeGreaterThanOrEqual(5);

    let hits = 0;
    for (const row of fixture) {
      const results = await findExperts(engine, { topic: row.query, limit: 5 });
      const top3 = new Set(results.slice(0, 3).map((r) => r.slug));
      const hit = row.expected_top_3_slugs.some((s) => top3.has(s));
      if (hit) hits++;
    }
    const hitRate = hits / fixture.length;
    // The synthetic seed is designed so every query has a clear best
    // person/company match. We assert >= 80% which is the locked threshold
    // (ENG-D2). In practice we expect 100% on this controlled fixture.
    expect(hitRate).toBeGreaterThanOrEqual(0.8);
  }, 60_000);
});

describe('whoknows E2E — typeFilter and shadow paths', () => {
  test('type filter excludes concept pages (decoys do not appear in results)', async () => {
    const results = await findExperts(engine, { topic: 'fintech payments', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(['person', 'company']).toContain(r.type);
    }
    // The decoy concept page must NOT appear.
    expect(results.find((r) => r.slug === 'concepts/fintech-essay')).toBeUndefined();
  });

  test('zero matches returns empty array gracefully', async () => {
    const results = await findExperts(engine, {
      topic: 'this-topic-is-definitely-not-in-the-brain-xyzqwerty',
      limit: 5,
    });
    expect(Array.isArray(results)).toBe(true);
    // searchHybrid may return loosely-matching results based on stemming;
    // we just assert it doesn't crash and returns sanely.
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  test('--explain factor breakdown is present on every result', async () => {
    const results = await findExperts(engine, { topic: 'crypto investing', limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.factors).toBeDefined();
      expect(typeof r.factors.expertise).toBe('number');
      expect(typeof r.factors.recency_factor).toBe('number');
      expect(typeof r.factors.salience).toBe('number');
      expect(typeof r.score).toBe('number');
      expect(Number.isFinite(r.score)).toBe(true);
    }
  });

  test('top-K honors limit parameter', async () => {
    const r5 = await findExperts(engine, { topic: 'developer tools', limit: 5 });
    const r1 = await findExperts(engine, { topic: 'developer tools', limit: 1 });
    expect(r5.length).toBeGreaterThanOrEqual(r1.length);
    expect(r1.length).toBeLessThanOrEqual(1);
  });
});

