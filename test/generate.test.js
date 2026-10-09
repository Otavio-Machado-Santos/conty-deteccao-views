import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SEED,
  buildDataset,
  serializeDataset,
  generateDatasetFile,
  loadDataset,
  expandDatasetSeries,
  DEFAULT_DATASET_PATH,
} from '../src/generate.js';
import { classify } from '../src/classify.js';

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

test('gerar com clock injetado não altera o corpo do dataset', () => {
  const { body: b1 } = generateDatasetFile(DEFAULT_DATASET_PATH, {
    seed: SEED,
    clock: () => new Date('2020-01-01T00:00:00.000Z'),
  });
  const { body: b2 } = generateDatasetFile(DEFAULT_DATASET_PATH, {
    seed: SEED,
    clock: () => new Date('2030-06-15T12:00:00.000Z'),
  });
  assert.equal(b1, b2);
});
