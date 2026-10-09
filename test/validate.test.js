import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSeries,
  expandCompact,
  SeriesValidationError,
} from '../src/validate.js';

const hour = (i) => new Date(Date.parse('2026-01-05T00:00:00.000Z') + i * 3_600_000).toISOString();

test('aceita série contígua UTC com views inteiros seguros não negativos', () => {
  const parsed = validateSeries([
    { timestamp: hour(0), views: 0 },
    { timestamp: hour(1), views: 1 },
    { timestamp: hour(2), views: Number.MAX_SAFE_INTEGER },
  ]);
  assert.equal(parsed.views.length, 3);
  assert.equal(parsed.stepMs, 3_600_000);
});

test('rejeita timestamp fora de UTC', () => {
  assert.throws(
    () =>
      validateSeries([
        { timestamp: '2026-01-05T00:00:00-03:00', views: 1 },
        { timestamp: '2026-01-05T01:00:00-03:00', views: 1 },
      ]),
    SeriesValidationError,
  );
});

test('rejeita passo não horário (série não contígua)', () => {
  assert.throws(
    () =>
      validateSeries([
        { timestamp: hour(0), views: 1 },
        { timestamp: hour(2), views: 1 },
      ]),
    /não é contíguo/,
  );
});

test('rejeita views não inteiro, negativo ou não seguro', () => {
  assert.throws(
    () => validateSeries([{ timestamp: hour(0), views: 1.5 }]),
    /inteiro/,
  );
  assert.throws(
    () => validateSeries([{ timestamp: hour(0), views: -1 }]),
    /não negativo/,
  );
  assert.throws(
    () => validateSeries([{ timestamp: hour(0), views: Number.MAX_SAFE_INTEGER + 2 }]),
    /inteiro seguro/,
  );
});

test('rejeita série vazia e formato inválido', () => {
  assert.throws(() => validateSeries([]), SeriesValidationError);
  assert.throws(() => validateSeries('nope'), SeriesValidationError);
});

test('expandCompact gera timestamps horários contíguos a partir de start', () => {
  const points = expandCompact({
    start: '2026-01-05T00:00:00.000Z',
    views: [10, 20, 30],
  });
  assert.equal(points[0].timestamp, '2026-01-05T00:00:00.000Z');
  assert.equal(points[1].timestamp, '2026-01-05T01:00:00.000Z');
  assert.equal(points[2].timestamp, '2026-01-05T02:00:00.000Z');
  assert.deepEqual(
    points.map((p) => p.views),
    [10, 20, 30],
  );
});
