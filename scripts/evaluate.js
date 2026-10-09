/**
 * npm run generate:evaluate
 *
 * 1. Regenera o dataset sintético (seed fixa) em disco.
 * 2. Compara a serialização byte a byte (reprodução determinística).
 * 3. Classifica cada série e calcula FPR (numerador/denominador),
 *    matriz de confusão, recall da classe suspeita e contagem de inconclusivos.
 * 4. Grava docs/evidence/evaluation.json.
 *
 * As métricas impressas são as medidas agora — não estimativas manuais.
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDataset,
  serializeDataset,
  generateDatasetFile,
  DEFAULT_DATASET_PATH,
  expandDatasetSeries,
} from '../src/generate.js';
import { classify } from '../src/classify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EVIDENCE_DIR = join(ROOT, 'docs', 'evidence');
const EVALUATION_PATH = join(EVIDENCE_DIR, 'evaluation.json');

export function evaluateDataset(dataset) {
  const rows = [];
  // Matriz: verdade sintética (legitimo|suspeito) × predição (3 classes)
  const matrix = {
    legitimo: { plausivel: 0, suspeito: 0, inconclusivo: 0 },
    suspeito: { plausivel: 0, suspeito: 0, inconclusivo: 0 },
  };

  let falsePositives = 0;
  let trueNegatives = 0;
  let legitimateTotal = 0;
  let truePositives = 0;
  let falseNegatives = 0;
  let suspiciousTotal = 0;
  let inconclusives = 0;

  for (const entry of dataset.series) {
    const points = expandDatasetSeries(entry);
    const outcome = classify(points);
    const predicted = outcome.classification;
    const label = entry.label;

    matrix[label][predicted] += 1;
    if (predicted === 'inconclusivo') inconclusives += 1;

    if (label === 'legitimo') {
      legitimateTotal += 1;
      if (predicted === 'suspeito') falsePositives += 1;
      // Abstinência (inconclusivo) e plausível não contam como falso positivo.
      if (predicted !== 'suspeito') trueNegatives += 1;
    } else if (label === 'suspeito') {
      suspiciousTotal += 1;
      if (predicted === 'suspeito') truePositives += 1;
      // Abstinência também não conta como verdadeiro positivo.
      if (predicted !== 'suspeito') falseNegatives += 1;
    }

    rows.push({
      id: entry.id,
      profile: entry.profile,
      label,
      classification: predicted,
      shape: outcome.shape,
      reason: outcome.reason,
    });
  }

  const fprDenominator = legitimateTotal;
  const fprNumerator = falsePositives;
  const fpr = fprDenominator === 0 ? 0 : fprNumerator / fprDenominator;
  const recallDenominator = suspiciousTotal;
  const recallNumerator = truePositives;
  const recall = recallDenominator === 0 ? 0 : recallNumerator / recallDenominator;

  return {
    counts: {
      series: dataset.series.length,
      legitimateTotal,
      suspiciousTotal,
      inconclusives,
      falsePositives,
      trueNegatives,
      truePositives,
      falseNegatives,
    },
    fpr: {
      numerator: fprNumerator,
      denominator: fprDenominator,
      value: fpr,
      percent: round(fpr * 100, 2),
      note: 'FPR = legítimos classificados como suspeitos / total de legítimos. Inconclusivo não é falso positivo (abstinência).',
    },
    recallSuspicious: {
      numerator: recallNumerator,
      denominator: recallDenominator,
      value: recall,
      percent: round(recall * 100, 2),
      note: 'Recall da classe suspeita = suspeitos detectados / total de suspeitos sintéticos. Inconclusivo conta como não detectado.',
    },
    confusionMatrix: matrix,
    rows,
  };
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function verifyByteReproduction() {
  const a = serializeDataset(buildDataset({ seed: 20261009, clock: () => new Date(0) }));
  const b = serializeDataset(buildDataset({ seed: 20261009, clock: () => new Date(0) }));
  const c = serializeDataset(buildDataset({ seed: 20261009, clock: () => new Date(1_700_000_000_000) }));
  return {
    identicalAcrossRuns: a === b,
    // generatedAt fica fora do payload canônico; o corpo deve ser igual
    // mesmo com relógios diferentes.
    identicalIgnoringClock: a === c,
    bytes: Buffer.byteLength(a, 'utf8'),
  };
}

export function runEvaluation({ writeEvidence = true } = {}) {
  const repro = verifyByteReproduction();
  if (!repro.identicalAcrossRuns || !repro.identicalIgnoringClock) {
    throw new Error('Dataset não é reproduzível byte a byte — abortando avaliação.');
  }

  const { dataset, body, path } = generateDatasetFile(DEFAULT_DATASET_PATH, {
    seed: 20261009,
    clock: () => new Date(),
  });

  // Confere que o arquivo em disco é idêntico ao payload canônico regenerado.
  const onDisk = readFileSync(path, 'utf8');
  const diskMatch = onDisk === body;

  const metrics = evaluateDataset(dataset);

  const report = {
    generatedAt: new Date().toISOString(),
    seed: 20261009,
    datasetPath: 'dataset/series.json',
    reproduction: {
      ...repro,
      diskMatchesCanonical: diskMatch,
    },
    metrics: {
      series: metrics.counts.series,
      falsePositives: metrics.fpr.numerator,
      legitimateTotal: metrics.fpr.denominator,
      fpr: metrics.fpr.value,
      fprPercent: metrics.fpr.percent,
      fprDisplay: `${metrics.fpr.numerator}/${metrics.fpr.denominator}`,
      recallSuspiciousNumerator: metrics.recallSuspicious.numerator,
      recallSuspiciousDenominator: metrics.recallSuspicious.denominator,
      recallSuspicious: metrics.recallSuspicious.value,
      recallSuspiciousPercent: metrics.recallSuspicious.percent,
      inconclusives: metrics.counts.inconclusives,
      confusionMatrix: metrics.confusionMatrix,
      counts: metrics.counts,
    },
    fprNote: metrics.fpr.note,
    recallNote: metrics.recallSuspicious.note,
    labelNote: dataset.meta.labelNote,
  };

  if (writeEvidence) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(
      EVALUATION_PATH,
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    report.evaluationPath = 'docs/evidence/evaluation.json';
  }

  return { report, metrics, rows: metrics.rows, dataset };
}

function printReport(report, rows) {
  const m = report.metrics;
  const lines = [
    '=== generate:evaluate ===',
    `seed: ${report.seed}`,
    `séries: ${m.series}`,
    `reprodução byte a byte: ${report.reproduction.identicalAcrossRuns && report.reproduction.diskMatchesCanonical ? 'OK' : 'FALHOU'}`,
    `bytes do dataset: ${report.reproduction.bytes}`,
    '',
    `FPR: ${m.fprDisplay} (${m.fprPercent}%)`,
    `  numerador (FP)   = ${m.falsePositives} legítimos classificados como suspeitos`,
    `  denominador (N)  = ${m.legitimateTotal} séries com rótulo sintético legítimo`,
    `Recall suspeito: ${m.recallSuspiciousNumerator}/${m.recallSuspiciousDenominator} (${m.recallSuspiciousPercent}%)`,
    `Inconclusivos: ${m.inconclusives}`,
    '',
    'Matriz de confusão (verdade sintética × predição):',
    `  legitimo → plausivel=${m.confusionMatrix.legitimo.plausivel} suspeito=${m.confusionMatrix.legitimo.suspeito} inconclusivo=${m.confusionMatrix.legitimo.inconclusivo}`,
    `  suspeito → plausivel=${m.confusionMatrix.suspeito.plausivel} suspeito=${m.confusionMatrix.suspeito.suspeito} inconclusivo=${m.confusionMatrix.suspeito.inconclusivo}`,
    '',
    'Por perfil (contagem por predição):',
  ];

  const byProfile = new Map();
  for (const row of rows) {
    const key = row.profile;
    const cur = byProfile.get(key) ?? {
      label: row.label,
      plausivel: 0,
      suspeito: 0,
      inconclusivo: 0,
    };
    cur[row.classification] += 1;
    byProfile.set(key, cur);
  }
  for (const [profile, cur] of byProfile) {
    lines.push(
      `  ${profile} [${cur.label}]: plausivel=${cur.plausivel} suspeito=${cur.suspeito} inconclusivo=${cur.inconclusivo}`,
    );
  }

  lines.push('');
  lines.push('Atenção: rótulos sintéticos; métricas valem só para este dataset.');
  console.log(lines.join('\n'));
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('scripts/evaluate.js') || process.argv[1].endsWith('evaluate.js'));

if (isMain) {
  const { report, rows } = runEvaluation({ writeEvidence: true });
  printReport(report, rows);
}
