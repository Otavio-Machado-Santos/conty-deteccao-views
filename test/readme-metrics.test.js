import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEvaluation } from '../scripts/evaluate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Lê o FPR declarado no README no formato fixo:
 *   FPR: <numerador>/<denominador> (<percent>%)
 * O teste NÃO edita o README — apenas falha se divergir do medido.
 */
function readFprFromReadme() {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const match = readme.match(/FPR:\s*(\d+)\/(\d+)\s*\(([\d.]+)%\)/);
  assert.ok(match, 'README.md precisa conter a linha "FPR: N/D (P%)"');
  return {
    numerator: Number(match[1]),
    denominator: Number(match[2]),
    percent: Number(match[3]),
  };
}

test('FPR do README bate com a medição do generate:evaluate', () => {
  const declared = readFprFromReadme();
  const { report } = runEvaluation({ writeEvidence: false });
  const measured = report.metrics;

  assert.equal(
    declared.numerator,
    measured.falsePositives,
    `numerador do README (${declared.numerator}) diverge do medido (${measured.falsePositives})`,
  );
  assert.equal(
    declared.denominator,
    measured.legitimateTotal,
    `denominador do README (${declared.denominator}) diverge do medido (${measured.legitimateTotal})`,
  );
  assert.equal(
    declared.percent,
    measured.fprPercent,
    `percentual do README (${declared.percent}%) diverge do medido (${measured.fprPercent}%)`,
  );
});

test('avaliação grava evaluation.json coerente com o cálculo', () => {
  const { report } = runEvaluation({ writeEvidence: false });
  const path = join(ROOT, 'docs', 'evidence', 'evaluation.json');
  assert.ok(existsSync(path), 'docs/evidence/evaluation.json deve existir');
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(onDisk.metrics.fprDisplay, report.metrics.fprDisplay);
  assert.equal(onDisk.metrics.falsePositives, report.metrics.falsePositives);
  assert.equal(onDisk.metrics.legitimateTotal, report.metrics.legitimateTotal);
  assert.equal(onDisk.metrics.recallSuspiciousNumerator, report.metrics.recallSuspiciousNumerator);
  assert.equal(onDisk.seed, 20261009);
});

test('reprodução byte a byte é confirmada na avaliação', () => {
  const { report } = runEvaluation({ writeEvidence: false });
  assert.equal(report.reproduction.identicalAcrossRuns, true);
  assert.equal(report.reproduction.diskMatchesCanonical, true);
});

test('runEvaluation(writeEvidence:false) é somente leitura: não altera dataset nem grava evidence/README', () => {
  const datasetPath = join(ROOT, 'dataset', 'series.json');
  const evaluationPath = join(ROOT, 'docs', 'evidence', 'evaluation.json');
  const readmePath = join(ROOT, 'README.md');

  const dsBefore = statSync(datasetPath);
  const dsBytesBefore = readFileSync(datasetPath);
  const evalBytesBefore = existsSync(evaluationPath) ? readFileSync(evaluationPath) : null;
  const readmeBefore = statSync(readmePath);
  const readmeBytesBefore = readFileSync(readmePath);

  const { report } = runEvaluation({ writeEvidence: false });
  assert.ok(report.metrics.series > 0);

  const dsAfter = statSync(datasetPath);
  const dsBytesAfter = readFileSync(datasetPath);
  assert.equal(dsBefore.ino, dsAfter.ino, 'inode do dataset não deve mudar');
  assert.equal(dsBefore.mtimeMs, dsAfter.mtimeMs, 'mtime do dataset não deve mudar');
  assert.equal(
    Buffer.compare(dsBytesBefore, dsBytesAfter),
    0,
    'bytes do dataset não devem mudar',
  );

  const evalBytesAfter = existsSync(evaluationPath) ? readFileSync(evaluationPath) : null;
  if (evalBytesBefore === null) {
    assert.equal(evalBytesAfter, null, 'não deve criar evaluation.json');
  } else {
    assert.equal(
      Buffer.compare(evalBytesBefore, evalBytesAfter),
      0,
      'evaluation.json não deve mudar',
    );
  }

  const readmeAfter = statSync(readmePath);
  assert.equal(readmeBefore.mtimeMs, readmeAfter.mtimeMs, 'README não deve ser tocado');
  assert.equal(Buffer.compare(readmeBytesBefore, readFileSync(readmePath)), 0);
});
