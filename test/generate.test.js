import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, unlinkSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  SEED,
  buildDataset,
  serializeDataset,
  generateDatasetFile,
  writeJsonAtomic,
  loadDataset,
  expandDatasetSeries,
  DEFAULT_DATASET_PATH,
} from '../src/generate.js';
import { classify } from '../src/classify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_DATASET = join(ROOT, 'dataset', 'series.json');
const GENERATE_URL = pathToFileURL(join(ROOT, 'src', 'generate.js')).href;

/** Caminho temporário próprio do teste, na mesma pasta do dataset. */
function tempPath(label) {
  return join(
    ROOT,
    'dataset',
    `.test-tmp-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

function removeIfExists(path) {
  if (existsSync(path)) unlinkSync(path);
}

test('dataset é reprodutível byte a byte com a seed fixa', () => {
  const a = serializeDataset(buildDataset({ seed: SEED, clock: () => new Date(0) }));
  const b = serializeDataset(buildDataset({ seed: SEED, clock: () => new Date(0) }));
  const c = serializeDataset(
    buildDataset({ seed: SEED, clock: () => new Date(1_700_000_000_000) }),
  );
  assert.equal(a, b);
  assert.equal(a, c);
});

test('dataset em disco corresponde ao payload canônico regenerado', () => {
  const onDisk = readFileSync(DEFAULT_DATASET_PATH, 'utf8');
  const regenerated = serializeDataset(buildDataset({ seed: SEED, clock: () => new Date(0) }));
  assert.equal(onDisk, regenerated);
});

test('todo item do dataset satisfaz o contrato de série contígua', () => {
  const dataset = loadDataset();
  assert.ok(dataset.series.length > 50);
  for (const entry of dataset.series) {
    const points = expandDatasetSeries(entry);
    assert.ok(points.length >= 6, `${entry.id} muito curta`);
    assert.equal(points.length, entry.views.length);
    assert.ok(['legitimo', 'suspeito'].includes(entry.label));
  }
});

test('perfis legítimos e suspeitos estão representados', () => {
  const dataset = loadDataset();
  const profiles = new Set(dataset.series.map((s) => s.profile));
  for (const expected of [
    'diurno',
    'viral_organico',
    'campanha_sustentada',
    'baixo_volume',
    'evento_rapido',
    'compra_abrupta',
    'repeticao_mecanica',
  ]) {
    assert.ok(profiles.has(expected), `falta perfil ${expected}`);
  }
});

test('viral orgânico do dataset não é acusado; compra abrupta é', () => {
  const dataset = loadDataset();
  const viral = dataset.series.find((s) => s.profile === 'viral_organico');
  const bought = dataset.series.find((s) => s.profile === 'compra_abrupta');
  const viralOutcome = classify(expandDatasetSeries(viral));
  const boughtOutcome = classify(expandDatasetSeries(bought));
  assert.equal(viralOutcome.classification, 'plausivel');
  assert.equal(boughtOutcome.classification, 'suspeito');
  assert.notEqual(viralOutcome.classification, boughtOutcome.classification);
});

test('gerar com clock injetado não altera o corpo do dataset (caminho isolado)', () => {
  // Caminho temporário próprio: não toca o dataset compartilhado.
  const before = statSync(SHARED_DATASET);
  const tmp = tempPath('clock');
  try {
    const { body: b1 } = generateDatasetFile(tmp, {
      seed: SEED,
      clock: () => new Date('2020-01-01T00:00:00.000Z'),
    });
    const { body: b2 } = generateDatasetFile(tmp, {
      seed: SEED,
      clock: () => new Date('2030-06-15T12:00:00.000Z'),
    });
    assert.equal(b1, b2);
  } finally {
    removeIfExists(tmp);
  }
  const after = statSync(SHARED_DATASET);
  assert.equal(before.ino, after.ino, 'dataset compartilhado não deve ser substituído');
  assert.equal(before.mtimeMs, after.mtimeMs, 'dataset compartilhado não deve ser tocado');
});

const WORKER_SOURCE = `
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
const { writeJsonAtomic } = await import(workerData.generateUrl);
const { role, target, body, iterations, fixedMs } = workerData;
// Todos os workers compartilham PID e o MESMO clock fixo: nomes baseados
// em pid+ms colidiriam de propósito. writeJsonAtomic não pode depender disso.
Date.now = () => fixedMs;
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', (msg) => {
  if (msg !== 'go') return;
  const errors = [];
  try {
    if (role === 'writer') {
      for (let i = 0; i < iterations; i += 1) {
        writeJsonAtomic(target, body);
      }
    } else {
      for (let i = 0; i < iterations; i += 1) {
        const raw = readFileSync(target, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.series) || parsed.series.length === 0) {
          errors.push('documento incompleto');
        }
        if (raw !== body) {
          errors.push('conteúdo difere do canônico');
        }
      }
    }
  } catch (err) {
    errors.push(String(err && err.message ? err.message : err));
  }
  parentPort.postMessage({ type: 'done', errors });
});
`;

function runWorker(role, { target, body, iterations, fixedMs, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { role, target, body, iterations, fixedMs, generateUrl: GENERATE_URL },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`worker ${role} excedeu ${timeoutMs}ms`));
    }, timeoutMs);
    const errors = [];
    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        worker.postMessage('go');
      } else if (msg.type === 'done') {
        clearTimeout(timer);
        resolve(msg.errors);
        worker.terminate();
      }
    });
    worker.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`worker ${role} saiu com code ${code}`));
    });
  });
}

test('publicação atômica com worker_threads: leitura concorrente nunca observa JSON parcial', async () => {
  const tmp = tempPath('atomic');
  const full = serializeDataset(buildDataset({ seed: SEED, clock: () => new Date(0) }));
  const fixedMs = 1_700_000_000_000;
  try {
    writeJsonAtomic(tmp, full);
    // 4 escritores + 2 leitores em threads independentes, mesmo PID e
    // mesmo clock fixo — cobre a colisão que nomes pid+ms não resistem.
    const writerIterations = 100; // 4 × 100 = 400 publicações
    const readerIterations = 100;
    const runs = await Promise.all([
      runWorker('writer', { target: tmp, body: full, iterations: writerIterations, fixedMs }),
      runWorker('writer', { target: tmp, body: full, iterations: writerIterations, fixedMs }),
      runWorker('writer', { target: tmp, body: full, iterations: writerIterations, fixedMs }),
      runWorker('writer', { target: tmp, body: full, iterations: writerIterations, fixedMs }),
      runWorker('reader', { target: tmp, body: full, iterations: readerIterations, fixedMs }),
      runWorker('reader', { target: tmp, body: full, iterations: readerIterations, fixedMs }),
    ]);
    const allErrors = runs.flat();
    assert.deepEqual(allErrors, [], `nenhum erro esperado em escrita/leitura concorrente`);
    // Documento final canônico e completo.
    assert.equal(readFileSync(tmp, 'utf8'), full);
    JSON.parse(readFileSync(tmp, 'utf8'));
  } finally {
    removeIfExists(tmp);
  }
});

test('writeJsonAtomic remove somente o temporário próprio em falha e não toca preexistentes', () => {
  const tmp = tempPath('cleanup');
  const dir = dirname(tmp);
  const prefix = `.${basename(tmp)}.`;
  // Arquivo temporário "alheio" preexistente com nome que a implementação
  // antiga (pid+ms) poderia reusar — não pode ser apagado por engano.
  const foreign = join(dir, `${prefix}foreign-preexisting.tmp`);
  try {
    writeFileSync(foreign, 'nao-apagar', 'utf8');
    let threw = false;
    try {
      writeJsonAtomic(tmp, undefined);
    } catch {
      threw = true;
    }
    assert.ok(threw, 'esperava falha no corpo inválido');
    assert.equal(existsSync(tmp), false, 'arquivo final não deve existir');
    assert.equal(existsSync(foreign), true, 'temporário preexistente deve preservar');
    assert.equal(readFileSync(foreign, 'utf8'), 'nao-apagar');
    // Nenhum .tmp órfão com o prefixo completo desta chamada além do preexistente conhecido.
    const leftovers = readdirSync(dir).filter(
      (n) => n.startsWith(prefix) && n.endsWith('.tmp') && n !== basename(foreign),
    );
    assert.deepEqual(leftovers, [], 'temporário próprio deve ser removido');
  } finally {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix) && name.endsWith('.tmp')) removeIfExists(join(dir, name));
    }
    removeIfExists(foreign);
    removeIfExists(tmp);
  }
});
