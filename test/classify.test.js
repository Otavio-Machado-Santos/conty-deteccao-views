import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, CLASSIFICATIONS, THRESHOLDS, SIGNAL_LABELS } from '../src/classify.js';
import { buildDataset, expandDatasetSeries } from '../src/generate.js';

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

// --- Regressões de falso positivo orgânico -------------------------------
// Baseline constante durante rampa suave NÃO vira "ritmo mecânico".
// Dados dos contraexemplos das revisões independentes 09-a / 09-b.

test('regressão: viral com baseline constante (rampa suave) não é acusado', () => {
  // counterexamples[0] de 09-a-probes.json / organicRepeatedBaseline de 09-b
  const views = [
    200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 295, 544, 896,
    1300, 1704, 2056, 2305, 2400, 2368, 2278, 2140, 1964, 1759, 1534, 1300,
    1066, 841, 636, 460, 322, 232, 200, 200, 200, 200, 200, 200, 200, 200,
    200, 200, 200, 200, 200, 200, 200, 200,
  ];
  const outcome = classify(series(views));
  assert.ok(outcome.flags.smoothRamp, 'deveria ter rampa suave');
  assert.equal(outcome.flags.mechanical, false, 'run de baseline não é mecânica');
  assert.ok(
    outcome.classification === CLASSIFICATIONS.PLAUSIBLE ||
      outcome.classification === CLASSIFICATIONS.INCONCLUSIVE,
    `esperava plausivel/inconclusivo, veio ${outcome.classification}`,
  );
  assert.notEqual(outcome.classification, CLASSIFICATIONS.SUSPICIOUS);
});

test('regressão: viral seed25 (run curta de baseline) não é acusado', () => {
  const dataset = buildDataset({ seed: 25, clock: () => new Date(0) });
  const entry = dataset.series.find((s) => s.id === 'viral_organico-000');
  assert.ok(entry, 'viral_organico-000 deve existir no seed 25');
  assert.equal(entry.label, 'legitimo');
  const outcome = classify(expandDatasetSeries(entry));
  assert.ok(
    outcome.classification === CLASSIFICATIONS.PLAUSIBLE ||
      outcome.classification === CLASSIFICATIONS.INCONCLUSIVE,
    `esperava plausivel/inconclusivo, veio ${outcome.classification} (${outcome.shape})`,
  );
  assert.notEqual(outcome.classification, CLASSIFICATIONS.SUSPICIOUS);
});

test('regressão: múltiplas seeds sem falso positivo nos legítimos', () => {
  // Cheque de sensibilidade sintético. Seeds vistas pelos revisores NÃO são
  // holdout independente de verdade: calibração e gerador compartilham
  // hipóteses; 0% neste conjunto não estima produção.
  for (const seed of [20261009, 25, 1, 2, 3, 7, 42, 99]) {
    const dataset = buildDataset({ seed, clock: () => new Date(0) });
    for (const entry of dataset.series) {
      if (entry.label !== 'legitimo') continue;
      const outcome = classify(expandDatasetSeries(entry));
      assert.notEqual(
        outcome.classification,
        CLASSIFICATIONS.SUSPICIOUS,
        `FP em seed=${seed} id=${entry.id} shape=${outcome.shape}`,
      );
    }
    // Recall dos suspeitos originais preservado
    for (const entry of dataset.series) {
      if (entry.label !== 'suspeito') continue;
      const outcome = classify(expandDatasetSeries(entry));
      assert.equal(
        outcome.classification,
        CLASSIFICATIONS.SUSPICIOUS,
        `FN em seed=${seed} id=${entry.id} veio ${outcome.classification} (${outcome.shape})`,
      );
    }
  }
});

// --- Picos orgânicos fora do gerador e coerência do motivo ---------------
// Auditoria de 10/10/2026: um post recente começa no pico e decai sem degrau
// de 4×; uma menção sobe de uma vez e decai devagar. Nenhum dos dois tem as
// duas bordas abruptas de um pico comprado.

function postRecente() {
  return Array.from({ length: 48 }, (_, t) => Math.round(5000 * (t + 1) ** -0.8));
}

function mencaoComCauda() {
  const views = [];
  for (let i = 0; i < 48; i += 1) {
    const tail = i < 12 ? 0 : Math.round(2400 * 0.55 ** (i - 12));
    views.push(200 + tail + jitter(i));
  }
  return views;
}

test('post recente decaindo do pico não é acusado (cai em abstenção)', () => {
  const outcome = classify(series(postRecente()));
  assert.equal(outcome.classification, CLASSIFICATIONS.INCONCLUSIVE);
  assert.equal(outcome.flags.abruptDrop, false);
  assert.ok(outcome.signals.narrowSpike.triggered, 'o sinal que pesou precisa aparecer em signals');
  assert.notEqual(outcome.classification, classify(series(picoComprado())).classification);
});

test('menção com subida abrupta e cauda sem queda abrupta não é acusada', () => {
  const outcome = classify(series(mencaoComCauda()));
  assert.ok(outcome.flags.abruptJump, 'a menção sobe de uma vez');
  assert.equal(outcome.flags.abruptDrop, false);
  assert.notEqual(outcome.classification, CLASSIFICATIONS.SUSPICIOUS);
});

test('motivo cita só sinais acionados, e o sinal que decide aparece em signals', () => {
  const inputs = [viralOrganico(), picoComprado(), ritmoMecanico(), postRecente(), mencaoComCauda()].map(series);
  for (const seed of [20261009, 1, 2, 3, 7, 42]) {
    const dataset = buildDataset({ seed, clock: () => new Date(0) });
    for (const entry of dataset.series) inputs.push(expandDatasetSeries(entry));
  }
  const bySignals = new Set(['pico_abrupto', 'pico_ambiguo', 'sinal_isolado', 'mecanica', 'rampa_suave']);
  for (const input of inputs) {
    const outcome = classify(input);
    const reason = outcome.reason.toLowerCase();
    for (const [key, label] of Object.entries(SIGNAL_LABELS)) {
      if (reason.includes(label)) {
        assert.equal(
          outcome.signals[key]?.triggered,
          true,
          `motivo cita "${label}" com o sinal desligado (${outcome.shape}): ${outcome.reason}`,
        );
      }
    }
    if (bySignals.has(outcome.shape)) {
      assert.ok(
        Object.values(outcome.signals).some((signal) => signal.triggered),
        `${outcome.shape} sem nenhum sinal acionado em signals`,
      );
    }
  }
  const bought = classify(series(picoComprado()));
  assert.match(bought.reason, /subida abrupta/);
  assert.match(bought.reason, /queda abrupta/);
});
