/**
 * npm run sensitivity -- [seedInicial] [seedFinal]
 *
 * Sensibilidade fora do dataset canônico, para documentar limites:
 * 1. Varre seeds do gerador (padrão 0–99) e conta falsos positivos, suspeitos
 *    detectados e abstenções, com o formato que gerou cada erro.
 * 2. Classifica famílias orgânicas que o gerador não produz: post recente
 *    decaindo desde a publicação, zeros antes da publicação, menção com cauda,
 *    rampa de 2 h com decaimento e onda de subida em 4 h.
 *
 * Não grava arquivos e não muda o dataset canônico nem o FPR do README.
 */

import { buildDataset, expandDatasetSeries } from '../src/generate.js';
import { classify } from '../src/classify.js';
import { createPrng, gaussian } from '../src/prng.js';

const FAMILY_SIZE = 500;
const HOUR_MS = 3_600_000;
const START_MS = Date.parse('2026-03-02T00:00:00.000Z');

function toPoints(views) {
  return views.map((v, i) => ({ timestamp: new Date(START_MS + i * HOUR_MS).toISOString(), views: v }));
}

function noisy(prng, value, pct) {
  return Math.max(0, Math.round(value * (1 + pct * gaussian(prng))));
}

const ORGANIC_FAMILIES = {
  post_recente: (r) => {
    const peak = 1000 + r() * 19000;
    const k = 0.5 + r() * 0.7;
    const pct = 0.05 + r() * 0.05;
    return Array.from({ length: 48 }, (_, t) => noisy(r, peak * (t + 1) ** -k, pct));
  },
  zeros_antes_da_publicacao: (r) => {
    const before = 3 + Math.floor(r() * 10);
    const peak = 1000 + r() * 19000;
    const k = 0.5 + r() * 0.7;
    const pct = 0.05 + r() * 0.05;
    return Array.from({ length: 48 }, (_, t) => (t < before ? 0 : noisy(r, peak * (t - before + 1) ** -k, pct)));
  },
  mencao_com_cauda: (r) => {
    const base = 80 + r() * 120;
    const mult = 5 + r() * 10;
    const at = 12 + Math.floor(r() * 20);
    const tail = [1, 0.35, 0.18, 0.1];
    return Array.from({ length: 48 }, (_, i) => {
      const d = i - at;
      const factor = d >= 0 && d < tail.length ? 1 + (mult - 1) * tail[d] : 1;
      return noisy(r, base * factor, 0.06);
    });
  },
  rampa_2h_decaimento: (r) => {
    const peak = 1000 + r() * 19000;
    const halfLife = 3 + r() * 9;
    const floor = peak * (0.01 + r() * 0.04);
    const pct = 0.05 + r() * 0.05;
    return Array.from({ length: 48 }, (_, t) => {
      const curve = t === 0 ? 0.4 * peak : t === 1 ? 0.8 * peak : peak * 0.5 ** ((t - 2) / halfLife);
      return noisy(r, curve + floor, pct);
    });
  },
  onda_subida_4h: (r) => {
    const base = 80 + r() * 120;
    const mult = 6 + r() * 9;
    const at = 14 + Math.floor(r() * 10);
    const halfLife = 4 + r() * 6;
    const step = mult ** (1 / 4);
    return Array.from({ length: 48 }, (_, i) => {
      let factor = 1;
      if (i > at - 4 && i <= at) factor = step ** (i - (at - 4));
      else if (i > at) factor = 1 + (mult - 1) * 0.5 ** ((i - at) / halfLife);
      return noisy(r, base * factor, 0.06);
    });
  },
};

function sweepSeeds(from, to) {
  const totals = { legit: 0, fp: 0, suspicious: 0, detected: 0, inconclusive: 0 };
  const errors = [];
  for (let seed = from; seed <= to; seed += 1) {
    for (const entry of buildDataset({ seed, clock: () => new Date(0) }).series) {
      const outcome = classify(expandDatasetSeries(entry));
      if (outcome.classification === 'inconclusivo') totals.inconclusive += 1;
      if (entry.label === 'legitimo') {
        totals.legit += 1;
        if (outcome.classification === 'suspeito') {
          totals.fp += 1;
          errors.push(`FP seed=${seed} ${entry.id} → ${outcome.shape}`);
        }
      } else {
        totals.suspicious += 1;
        if (outcome.classification === 'suspeito') totals.detected += 1;
        else errors.push(`FN seed=${seed} ${entry.id} → ${outcome.classification}/${outcome.shape}`);
      }
    }
  }
  return { totals, errors };
}

function sweepFamilies() {
  const rows = {};
  for (const [name, generate] of Object.entries(ORGANIC_FAMILIES)) {
    const prng = createPrng(20261010 + name.length);
    const counts = { plausivel: 0, suspeito: 0, inconclusivo: 0 };
    for (let k = 0; k < FAMILY_SIZE; k += 1) counts[classify(toPoints(generate(prng))).classification] += 1;
    rows[name] = counts;
  }
  return rows;
}

const [from = 0, to = 99] = process.argv.slice(2).map(Number);
const { totals, errors } = sweepSeeds(from, to);

console.log('=== sensitivity ===');
console.log(`seeds do gerador: ${from}–${to}`);
console.log(`FP: ${totals.fp}/${totals.legit} legítimos`);
console.log(`suspeitos detectados: ${totals.detected}/${totals.suspicious}`);
console.log(`inconclusivos: ${totals.inconclusive}`);
for (const line of errors) console.log(`  ${line}`);
console.log('');
console.log(`famílias orgânicas fora do gerador (${FAMILY_SIZE} séries cada):`);
for (const [name, counts] of Object.entries(sweepFamilies())) {
  console.log(`  ${name}: plausivel=${counts.plausivel} suspeito=${counts.suspeito} inconclusivo=${counts.inconclusivo}`);
}
console.log('');
console.log('Medição de sensibilidade de desenvolvimento: rótulos sintéticos, não estima produção.');
