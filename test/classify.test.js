import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, CLASSIFICATIONS, THRESHOLDS } from '../src/classify.js';

const baseStart = Date.parse('2026-01-05T00:00:00.000Z');
const hour = (i) => new Date(baseStart + i * 3_600_000).toISOString();

function series(views) {
  return views.map((views, i) => ({ timestamp: hour(i), views }));
}

/** Micro-variação determinística — tráfego orgânico tem ruído; baseline
 *  perfeitamente constante dispararia o sinal mecânico (corretamente). */
function jitter(i, magnitude = 1) {
  return ((i * 17) % 5) - 2 * magnitude;
}

/** Subida e queda gradual (viral orgânico), ~12× a base, rampas longas. */
function viralOrganico() {
  const views = [];
  for (let i = 0; i < 48; i += 1) {
    let v = 100;
    if (i >= 10 && i < 18) {
      const t = (i - 10) / 8;
      v = 100 + 1100 * (t * t * (3 - 2 * t));
    } else if (i >= 18 && i < 32) {
      const t = (i - 18) / 14;
      v = 1200 - 1100 * (t * t * (3 - 2 * t));
    }
    views.push(Math.round(v) + jitter(i));
  }
  return views;
}

/** Pico comprado: 25× a base em 2 horas, subida e queda abruptas. */
function picoComprado() {
  const views = [];
  for (let i = 0; i < 48; i += 1) {
    views.push(i >= 20 && i < 22 ? 2500 + jitter(i, 2) : 100 + jitter(i));
  }
  return views;
}

/** Ritmo mecânico: 6 horas com exatamente 500 views no meio da série. */
function ritmoMecanico() {
  const views = [];
  for (let i = 0; i < 48; i += 1) {
    views.push(i >= 18 && i < 24 ? 500 : 100 + (i % 3) * 5);
  }
  return views;
}

test('viral orgânico (rampa suave) não é acusado mesmo com pico alto', () => {
  const outcome = classify(series(viralOrganico()));
  assert.equal(outcome.classification, CLASSIFICATIONS.PLAUSIBLE);
  assert.notEqual(outcome.classification, CLASSIFICATIONS.SUSPICIOUS);
  assert.ok(outcome.rawMetrics.peakToBase >= THRESHOLDS.ORGANIC_MIN_PEAK_TO_BASE);
  assert.match(outcome.reason, /graduais|orgânico|legítimo/i);
});

test('pico comprado abrupto é suspeito e se distingue do viral', () => {
  const viral = classify(series(viralOrganico()));
  const bought = classify(series(picoComprado()));

  assert.equal(bought.classification, CLASSIFICATIONS.SUSPICIOUS);
  assert.notEqual(bought.classification, viral.classification);
  assert.ok(bought.flags.abruptJump || bought.flags.narrowSpike);
  assert.ok(bought.flags.highPeakToBase || bought.flags.highConcentration);
  assert.match(bought.reason, /abrupto|compra|mecânico/i);
});

test('ritmo mecânico com volume suficiente é suspeito', () => {
  const outcome = classify(series(ritmoMecanico()));
  assert.equal(outcome.classification, CLASSIFICATIONS.SUSPICIOUS);
  assert.equal(outcome.shape, 'mecanica');
  assert.ok(outcome.flags.mechanical);
  assert.ok(outcome.rawMetrics.maxIdenticalRun >= THRESHOLDS.MECHANICAL_RUN);
});

test('abstém com poucos pontos horários', () => {
  const outcome = classify(series([10, 20, 30, 40, 50]));
  assert.equal(outcome.classification, CLASSIFICATIONS.INCONCLUSIVE);
  assert.match(outcome.reason, /curta|pontos/i);
});

test('abstém com volume total baixo', () => {
  const views = Array.from({ length: 24 }, (_, i) => (i % 5) + 1);
  const outcome = classify(series(views));
  assert.equal(outcome.classification, CLASSIFICATIONS.INCONCLUSIVE);
  assert.match(outcome.reason, /baixo|volume/i);
});

test('abstém em pico isolado ambíguo (prefere não acusar)', () => {
  // Evento legítimo curto: pico moderado (~5×) em 2 horas, com cauda.
  // Sinais parciais sem combinação suficiente — não deve virar suspeito.
  const views = [];
  for (let i = 0; i < 36; i += 1) {
    let v = 150;
    if (i >= 14 && i < 16) v = 750;
    else if (i >= 16 && i < 22) v = Math.round(750 - ((i - 16) / 6) * 600);
    views.push(v + jitter(i));
  }
  const outcome = classify(series(views));
  assert.equal(outcome.classification, CLASSIFICATIONS.INCONCLUSIVE);
  assert.notEqual(outcome.classification, CLASSIFICATIONS.SUSPICIOUS);
  assert.match(outcome.reason, /preferimos não acusar|ambíguo|parciais/i);
});

test('classificação suspeita traz disclaimer e motivo legível', () => {
  const outcome = classify(series(picoComprado()));
  assert.ok(outcome.reason.length > 40);
  assert.match(outcome.disclaimer, /não prova de fraude|não é prova/i);
  assert.ok(outcome.signals.peakToBase);
  assert.ok(outcome.signals.concentration);
});

test('valores inválidos não viram suspeito', () => {
  const outcome = classify([{ timestamp: hour(0), views: -5 }]);
  assert.equal(outcome.classification, CLASSIFICATIONS.INCONCLUSIVE);
  assert.match(outcome.reason, /fora do contrato|não negativo|inteiros seguros/i);
  assert.notEqual(outcome.classification, CLASSIFICATIONS.SUSPICIOUS);
});
