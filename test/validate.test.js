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
    { timestamp: hour(2), views: Number.MAX_SAFE_INTEGER - 1 },
  ]);
  assert.equal(parsed.views.length, 3);
  assert.equal(parsed.stepMs, 3_600_000);
  assert.equal(parsed.total, Number.MAX_SAFE_INTEGER);
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

test('aceita equivalência Z e +00:00 em timestamps válidos', () => {
  const z = validateSeries([
    { timestamp: '2026-01-05T00:00:00Z', views: 1 },
    { timestamp: '2026-01-05T01:00:00Z', views: 2 },
  ]);
  const offset = validateSeries([
    { timestamp: '2026-01-05T00:00:00+00:00', views: 1 },
    { timestamp: '2026-01-05T01:00:00+00:00', views: 2 },
  ]);
  assert.equal(z.startMs, offset.startMs);
});

test('rejeita calendário inexistente (fev 30, fev 29 em ano não bissexto)', () => {
  assert.throws(
    () =>
      validateSeries([
        { timestamp: '2026-02-30T00:00:00Z', views: 100 },
        { timestamp: '2026-02-30T01:00:00Z', views: 100 },
      ]),
    /data civil existente/,
  );
  assert.throws(
    () => validateSeries([{ timestamp: '2026-02-29T00:00:00Z', views: 1 }]),
    /data civil existente/,
  );
  // 2028 é bissexto — fev 29 é válido
  const ok = validateSeries([{ timestamp: '2028-02-29T00:00:00Z', views: 1 }]);
  assert.equal(ok.views.length, 1);
});

test('rejeita formatos não ISO e strings RFC terminadas em Z', () => {
  assert.throws(
    () => validateSeries([{ timestamp: 'Mon, 05 Jan 2026 00:00:00 Z', views: 1 }]),
    /ISO UTC estrito/,
  );
  assert.throws(
    () => validateSeries([{ timestamp: '2026-01-05T00:00:00.000+0000', views: 1 }]),
    /ISO UTC estrito/,
  );
  assert.throws(
    () => validateSeries([{ timestamp: '2026-01-05 00:00:00Z', views: 1 }]),
    /ISO UTC estrito/,
  );
});

test('rejeita timestamps não alinhados à hora cheia', () => {
  assert.throws(
    () => validateSeries([{ timestamp: '2026-01-05T00:30:00Z', views: 1 }]),
    /alinhado à hora cheia/,
  );
  assert.throws(
    () => validateSeries([{ timestamp: '2026-01-05T00:00:00.500Z', views: 1 }]),
    /alinhado à hora cheia/,
  );
});

test('rejeita soma de views acima do total seguro', () => {
  const huge = Number.MAX_SAFE_INTEGER;
  assert.throws(
    () =>
      validateSeries([
        { timestamp: hour(0), views: huge },
        { timestamp: hour(1), views: 1 },
        { timestamp: hour(2), views: 1 },
        { timestamp: hour(3), views: 1 },
        { timestamp: hour(4), views: 1 },
        { timestamp: hour(5), views: 1 },
      ]),
    /total seguro/,
  );
  // Total exatamente no limite é aceito
  const ok = validateSeries([
    { timestamp: hour(0), views: huge },
    { timestamp: hour(1), views: 0 },
  ]);
  assert.equal(ok.total, huge);
});

test('aceita anos de quatro dígitos abaixo de 100 sem remapeamento Date.UTC', () => {
  // Date.UTC(99, ...) viraria 1999; o parse deve preservar o ano civil.
  const y99 = validateSeries([
    { timestamp: '0099-01-05T00:00:00Z', views: 1 },
    { timestamp: '0099-01-05T01:00:00Z', views: 2 },
  ]);
  assert.equal(new Date(y99.startMs).getUTCFullYear(), 99);
  const y5 = validateSeries([
    { timestamp: '0005-01-05T00:00:00Z', views: 1 },
    { timestamp: '0005-01-05T01:00:00Z', views: 2 },
  ]);
  assert.equal(new Date(y5.startMs).getUTCFullYear(), 5);
});

test('bissexto de século: 1900 inválido, 2000 e 0000 válidos', () => {
  assert.throws(
    () => validateSeries([{ timestamp: '1900-02-29T00:00:00Z', views: 1 }]),
    /data civil existente/,
  );
  const y2000 = validateSeries([{ timestamp: '2000-02-29T00:00:00Z', views: 1 }]);
  assert.equal(new Date(y2000.startMs).getUTCFullYear(), 2000);
  const y0 = validateSeries([{ timestamp: '0000-02-29T00:00:00Z', views: 1 }]);
  assert.equal(new Date(y0.startMs).getUTCFullYear(), 0);
});

test('rejeita espaço anterior/posterior ao timestamp (sem trim silencioso)', () => {
  assert.throws(
    () => validateSeries([{ timestamp: ' 2026-01-05T00:00:00Z', views: 1 }]),
    /ISO UTC estrito/,
  );
  assert.throws(
    () => validateSeries([{ timestamp: '2026-01-05T00:00:00Z ', views: 1 }]),
    /ISO UTC estrito/,
  );
  assert.throws(
    () => validateSeries([{ timestamp: '2026-01-05T00:00:00Z\n', views: 1 }]),
    /ISO UTC estrito/,
  );
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
