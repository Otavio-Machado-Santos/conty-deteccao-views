import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';

const repo = process.argv[2];
const priorPath = process.argv[3];
const load = (path) => import(pathToFileURL(join(repo, path)));
const { classify } = await load('src/classify.js');
const { buildDataset, serializeDataset } = await load('src/generate.js');
const { evaluateDataset } = await load('scripts/evaluate.js');
const { createServer, BODY_LIMIT_BYTES } = await load('src/server.js');
const prior = JSON.parse(readFileSync(priorPath, 'utf8'));
const counterexamples = prior.counterexamples.map(({ name, views }) => ({ name, ...classify(views) }));
assert.equal(counterexamples[0].classification, 'plausivel');
assert.equal(counterexamples[1].classification, 'plausivel');

const aggregate = (seeds) => {
  let fp = 0, legitimate = 0, detected = 0, suspicious = 0, abstentions = 0;
  const falsePositiveCases = [];
  for (const seed of seeds) {
    const result = evaluateDataset(buildDataset({ seed, clock: () => new Date(0) }));
    fp += result.fpr.numerator;
    legitimate += result.fpr.denominator;
    detected += result.recallSuspicious.numerator;
    suspicious += result.recallSuspicious.denominator;
    abstentions += result.counts.inconclusives;
    for (const row of result.rows.filter((row) => row.label === 'legitimo' && row.classification === 'suspeito')) falsePositiveCases.push({ seed, ...row });
  }
  return { seeds: seeds.length, seed_range: [seeds[0], seeds.at(-1)], false_positives: fp, legitimate, detected, suspicious, abstentions, false_positive_cases: falsePositiveCases };
};
const sameSeeds = aggregate(Array.from({ length: 100 }, (_, i) => i + 1));
const additionalSeeds = aggregate(Array.from({ length: 100 }, (_, i) => i + 1000));
const entry25 = buildDataset({ seed: 25, clock: () => new Date(0) }).series.find((s) => s.id === 'viral_organico-000');
const seed25 = classify(entry25.views);
assert.notEqual(seed25.classification, 'suspeito');

const bytes = readFileSync(join(repo, 'dataset/series.json'));
const canonical = serializeDataset(buildDataset({ seed: 20261009, clock: () => new Date(0) }));
assert.equal(bytes.toString(), canonical);
const sha256 = createHash('sha256').update(bytes).digest('hex');

const server = createServer({ clock: () => new Date('2026-10-09T00:00:00.000Z') });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const hour = (i) => new Date(Date.parse('2026-01-05T00:00:00.000Z') + i * 3600000).toISOString();
const points = (values) => values.map((views, i) => ({ timestamp: hour(i), views }));
const api = [];
const badBodies = [
  ['empty_series', { series: [] }],
  ['negative_array', { series: [-1, 2, 3, 4, 5, 6] }],
  ['missing_series', { other: 'missing' }],
  ['bare_array', points([1, 2, 3])],
  ['numeric_series', { series: [1, 2, 3] }],
  ['overflow_total', { series: points([Number.MAX_SAFE_INTEGER, 1, 1, 1, 1, 1]) }],
  ['impossible_calendar', { series: Array.from({ length: 6 }, (_, i) => ({ timestamp: `2026-02-30T${String(i).padStart(2, '0')}:00:00.000Z`, views: 100 + i })) }],
  ['century_not_leap', { series: [{ timestamp: '1900-02-29T00:00:00Z', views: 1 }] }],
];
async function post(name, body, expected) {
  const response = await fetch(`${base}/classify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json();
  assert.equal(response.status, expected, `${name}: ${JSON.stringify(json)}`);
  api.push({ name, status: response.status, response: json });
}
function raw(name, headers, chunks, expected, path = '/classify') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: path === '/health' ? 'GET' : 'POST', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          assert.equal(res.statusCode, expected);
          api.push({ name, status: res.statusCode, response: JSON.parse(body) });
          resolve();
        } catch (err) { reject(err); }
      });
    });
    req.setTimeout(4000, () => req.destroy(new Error(`${name}: timeout`)));
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}
try {
  for (const [name, body] of badBodies) await post(name, body, 422);
  await post('safe_sum_limit', { series: points([Number.MAX_SAFE_INTEGER - 5, 1, 1, 1, 1, 1]) }, 200);
  await post('valid_low_volume_abstention', { series: points([1, 2, 3]) }, 200);
  await post('valid_leap_century', { series: [{ timestamp: '2000-02-29T00:00:00+00:00', views: 1 }] }, 200);
  for (const rawBody of ['{not json', '', '   ']) {
    const response = await fetch(`${base}/classify`, { method: 'POST', body: rawBody });
    assert.equal(response.status, 400);
    api.push({ name: `invalid_json:${rawBody}`, status: response.status, response: await response.json() });
  }
  await raw('oversize_content_length', { 'content-length': BODY_LIMIT_BYTES + 1 }, [Buffer.alloc(BODY_LIMIT_BYTES + 1, 120)], 413);
  await raw('oversize_chunked', {}, Array.from({ length: 21 }, () => Buffer.alloc(100000, 120)), 413);
  await raw('malformed_host_health', { host: '[bad' }, [], 200, '/health');
  await raw('health_after_adversarial_requests', {}, [], 200, '/health');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
const report = { passed: true, reproduction: { identical: true, sha256 }, counterexamples, same_seed_range: sameSeeds, additional_seed_range: additionalSeeds, seed25: { classification: seed25.classification, shape: seed25.shape, reason: seed25.reason }, api };
if (process.argv[4]) writeFileSync(process.argv[4], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, counterexamples: counterexamples.map(({name,classification})=>({name,classification})), api: api.map(({name,status})=>({name,status})) }, null, 2));
