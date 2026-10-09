import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [archive, evidencePath] = process.argv.slice(2);
assert.ok(archive && evidencePath);
const { writeJsonAtomic } = await import(pathToFileURL(join(archive, 'src/generate.js')).href);
const { runEvaluation } = await import(pathToFileURL(join(archive, 'scripts/evaluate.js')).href);
const scratch = mkdtempSync(join(tmpdir(), 'review09b31-atomic-'));
const hash = raw => createHash('sha256').update(raw).digest('hex');
const report = { reviewed_sha: '31bb2150d1758c9c2efbbfc73e506f4973597ca7' };

function snapshot(paths) {
  return Object.fromEntries(paths.map(path => {
    try {
      const stat = statSync(path, { bigint: true });
      return [path, { bytes: stat.size.toString(), inode: stat.ino.toString(), mtimeNs: stat.mtimeNs.toString(), hash: hash(readFileSync(path)) }];
    } catch (error) {
      if (error.code === 'ENOENT') return [path, null];
      throw error;
    }
  }));
}

const workerSource = `
  import assert from 'node:assert/strict';
  import { workerData, parentPort } from 'node:worker_threads';
  import { readFileSync } from 'node:fs';
  import { createHash } from 'node:crypto';
  const { writeJsonAtomic } = await import(workerData.generator);
  const gate = new Int32Array(workerData.gate);
  Date.now = () => 1700000000000;
  parentPort.postMessage({ type: 'ready', pid: process.pid, clock: Date.now() });
  Atomics.wait(gate, 0, 0);
  const results = { role: workerData.role, id: workerData.id, writes: 0, reads: 0, observed: [] };
  try {
    if (workerData.role === 'writer') {
      for (let i = 0; i < workerData.iterations; i++) {
        writeJsonAtomic(workerData.target, workerData.bodies[(i + workerData.id) % workerData.bodies.length]);
        results.writes++;
      }
      Atomics.sub(gate, 1, 1);
    } else {
      const observed = new Set();
      do {
        const raw = readFileSync(workerData.target);
        const actual = createHash('sha256').update(raw).digest('hex');
        assert.ok(workerData.hashes.includes(actual), 'bytes parciais ou mistura de versões: ' + actual);
        const value = JSON.parse(raw.toString('utf8'));
        assert.equal(value.version, workerData.hashes.indexOf(actual));
        assert.ok(value.payload.endsWith('terminação-é-🙂'));
        observed.add(actual);
        results.reads++;
        assert.ok(results.reads < 20000, 'writers não terminaram');
      } while (Atomics.load(gate, 1) > 0 || results.reads < 120);
      results.observed = [...observed];
    }
    parentPort.postMessage({ type: 'done', results });
  } catch (error) {
    parentPort.postMessage({ type: 'failure', message: error.stack });
  }
`;

const bodies = [0, 1, 2].map(version => JSON.stringify({ version, payload: 'é汉🙂'.repeat(45000 + version * 9500) + 'terminação-é-🙂' }) + '\n');
const hashes = bodies.map(hash);
const target = join(scratch, 'shared.json');
writeJsonAtomic(target, bodies[0]);
const gate = new SharedArrayBuffer(8);
const state = new Int32Array(gate);
state[1] = 4;
const workers = [];
const ready = [];
const tasks = [];

try {
  for (let id = 0; id < 7; id++) {
    const worker = new Worker(workerSource, { eval: true, workerData: { role: id < 4 ? 'writer' : 'reader', id, gate, bodies, hashes, target, iterations: 75, generator: pathToFileURL(join(archive, 'src/generate.js')).href } });
    workers.push(worker);
    ready.push(new Promise((resolve, reject) => {
      worker.on('message', msg => { if (msg.type === 'ready') resolve(msg); });
      worker.once('error', reject);
    }));
    tasks.push(new Promise((resolve, reject) => {
      worker.on('message', msg => {
        if (msg.type === 'done') resolve(msg.results);
        else if (msg.type === 'failure') reject(new Error(msg.message));
      });
      worker.once('error', reject);
      worker.once('exit', code => { if (code !== 0) reject(new Error('exit ' + code)); });
    }));
  }
  const timeout = setTimeout(() => { for (const worker of workers) worker.terminate(); }, 20000);
  const readiness = await Promise.all(ready);
  assert.equal(new Set(readiness.map(value => value.pid)).size, 1);
  assert.equal(new Set(readiness.map(value => value.clock)).size, 1);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0, 7);
  const results = await Promise.all(tasks);
  clearTimeout(timeout);
  await Promise.all(workers.map(worker => worker.terminate()));
  const finalBytes = readFileSync(target);
  assert.ok(hashes.includes(hash(finalBytes)));
  assert.deepEqual(readdirSync(scratch), ['shared.json']);
  report.concurrent = { writers: 4, readers: 3, simultaneous_barrier: true, same_pid: true, fixed_clock: readiness[0].clock, variant_byte_lengths: bodies.map(body => Buffer.byteLength(body)), writes: results.reduce((sum, result) => sum + result.writes, 0), reads: results.reduce((sum, result) => sum + result.reads, 0), results, final_hash: hash(finalBytes), orphan_temps: [], errors: [] };
} finally {
  await Promise.all(workers.map(worker => worker.terminate()));
}

// Force an exact UUID collision in an isolated subprocess. The function must
// retain the pre-existing temp, retain the target and propagate EEXIST.
const injectedSource = `
  import assert from 'node:assert/strict';
  import crypto from 'node:crypto';
  import fs from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  import { join } from 'node:path';
  const [folder, moduleUrl] = process.argv.slice(1);
  crypto.randomUUID = () => 'forced-owned-probe';
  syncBuiltinESMExports();
  const { writeJsonAtomic } = await import(moduleUrl);
  const target = join(folder, 'collision.json');
  const foreign = join(folder, '.collision.json.forced-owned-probe.tmp');
  fs.writeFileSync(target, 'old target');
  fs.writeFileSync(foreign, 'foreign sentinel');
  assert.throws(() => writeJsonAtomic(target, '{"next":true}'), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'old target');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign sentinel');
  fs.unlinkSync(foreign);
  assert.throws(() => writeJsonAtomic(target, undefined), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'old target');
  assert.equal(fs.existsSync(foreign), false);
  const directoryTarget = join(folder, 'rename-directory');
  fs.mkdirSync(directoryTarget);
  fs.writeFileSync(join(directoryTarget, 'sentinel'), 'directory preserved');
  assert.throws(() => writeJsonAtomic(directoryTarget, '{"ok":true}'), error => ['EISDIR','ENOTDIR','EEXIST'].includes(error.code));
  assert.equal(fs.readFileSync(join(directoryTarget, 'sentinel'), 'utf8'), 'directory preserved');
  assert.equal(fs.existsSync(join(folder, '.rename-directory.forced-owned-probe.tmp')), false);
  console.log(JSON.stringify({ exact_uuid_collision: 'EEXIST propagated; foreign temp and target preserved', invalid_body: 'target preserved; own temp cleaned', rename_failure: 'directory preserved; own temp cleaned' }));
`;
const forced = spawnSync(process.execPath, ['--input-type=module', '-e', injectedSource, scratch, pathToFileURL(join(archive, 'src/generate.js')).href], { encoding: 'utf8', timeout: 15000 });
assert.equal(forced.status, 0, forced.stdout + forced.stderr);
report.failures = JSON.parse(forced.stdout.trim());

const datasetPath = join(archive, 'dataset/series.json');
const evaluationPath = join(archive, 'docs/evidence/evaluation.json');
const readmePath = join(archive, 'README.md');
const originalDataset = readFileSync(datasetPath);
const originalEvaluation = readFileSync(evaluationPath);
const observedPaths = [datasetPath, evaluationPath, readmePath];
report.readonly = [];
try {
  for (const condition of ['canonical', 'corrupt', 'missing', 'missing_evidence']) {
    if (condition === 'corrupt') writeFileSync(datasetPath, 'truncated {');
    if (condition === 'missing') rmSync(datasetPath);
    if (condition === 'missing_evidence') {
      writeFileSync(datasetPath, originalDataset);
      rmSync(evaluationPath);
    }
    const before = snapshot(observedPaths);
    const { report: measured } = runEvaluation({ writeEvidence: false });
    const after = snapshot(observedPaths);
    assert.deepEqual(after, before, 'readonly mutated disk for ' + condition);
    assert.equal(measured.reproduction.diskMatchesCanonical, !['corrupt', 'missing'].includes(condition));
    assert.equal(measured.metrics.fprDisplay, '0/72');
    report.readonly.push({ condition, unchanged: true, disk_matches_canonical: measured.reproduction.diskMatchesCanonical, before, after });
  }
} finally {
  writeFileSync(datasetPath, originalDataset);
  writeFileSync(evaluationPath, originalEvaluation);
  rmSync(scratch, { recursive: true, force: true });
}

writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ writes: report.concurrent.writes, reads: report.concurrent.reads, errors: 0, distinct_json_variants: bodies.length, byte_lengths: report.concurrent.variant_byte_lengths, exact_collision_preserved: true, rename_failure_preserved: true, readonly_conditions: report.readonly.length }));
