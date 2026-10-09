/**
 * Sinais quantitativos explicáveis sobre uma série de views incrementais por hora.
 * Todos os valores são derivados apenas da série; nada aqui é "score" opaco.
 */

function median(sortedAsc) {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

function hourOfIndex(startMs, index) {
  return new Date(startMs + index * 3_600_000).getUTCHours();
}

/**
 * @param {number[]} views valores incrementais por hora (>= 0, inteiros)
 * @param {number} startMs timestamp UTC do primeiro ponto
 */
export function computeSignals(views, startMs = 0) {
  const n = views.length;
  const total = views.reduce((acc, v) => acc + v, 0);
  let peak = 0;
  let peakIdx = 0;
  for (let i = 0; i < n; i += 1) {
    if (views[i] > peak) {
      peak = views[i];
      peakIdx = i;
    }
  }

  const sortedAsc = [...views].sort((a, b) => a - b);
  const med = median(sortedAsc);
  const base = Math.max(med, 1);

  const peakToBase = peak / base;
  const peakShare = total > 0 ? peak / total : 0;

  const top3Sum = [...views]
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((acc, v) => acc + v, 0);
  const top3Share = total > 0 ? top3Sum / total : 0;

  // Variação multiplicativa hora a hora (fator de subida e de queda).
  // Ex.: 100 → 2500 tem fator de subida 25×; 2500 → 100 tem fator de queda 25×.
  let maxRiseRatio = 0;
  let maxDropRatio = 0;
  let maxRiseIdx = -1;
  let maxDropIdx = -1;
  for (let i = 1; i < n; i += 1) {
    const prev = Math.max(views[i - 1], 1);
    const cur = Math.max(views[i], 1);
    const rise = cur / prev;
    const drop = prev / cur;
    if (rise > maxRiseRatio) {
      maxRiseRatio = rise;
      maxRiseIdx = i;
    }
    if (drop > maxDropRatio) {
      maxDropRatio = drop;
      maxDropIdx = i;
    }
  }

  // Largura do pico: horas acima da metade entre mediana e pico.
  const halfLevel = med + 0.5 * (peak - med);
  let left = peakIdx;
  let right = peakIdx;
  while (left > 0 && views[left - 1] >= halfLevel) left -= 1;
  while (right < n - 1 && views[right + 1] >= halfLevel) right += 1;
  const spikeWidth = right - left + 1;

  // Rampa em torno do pico: horas do início/fim da região elevada até o pico.
  const riseHours = peakIdx - left;
  const fallHours = right - peakIdx;

  // Maior degrau multiplicativo hora a hora (subida ou queda) em toda a série.
  let maxRampStep = 1;
  for (let i = 1; i < n; i += 1) {
    const prev = Math.max(views[i - 1], 1);
    const cur = Math.max(views[i], 1);
    maxRampStep = Math.max(maxRampStep, cur / prev, prev / cur);
  }

  // Repetição exata de valores consecutivos.
  let maxIdenticalRun = n > 0 ? 1 : 0;
  let runValue = n > 0 ? views[0] : 0;
  let curRun = 1;
  for (let i = 1; i < n; i += 1) {
    if (views[i] === views[i - 1] && views[i] > 0) {
      curRun += 1;
    } else {
      curRun = views[i] > 0 ? 1 : 0;
    }
    if (curRun > maxIdenticalRun) {
      maxIdenticalRun = curRun;
      runValue = views[i];
    }
  }
  const runShare = total > 0 ? (runValue * maxIdenticalRun) / total : 0;

  // Concentração em uma janela curta (3 horas) — captura "compra" concentrada.
  let maxWindow3 = 0;
  for (let i = 0; i + 2 < n; i += 1) {
    const w = views[i] + views[i + 1] + views[i + 2];
    if (w > maxWindow3) maxWindow3 = w;
  }
  const window3Share = total > 0 ? maxWindow3 / total : 0;

  // Padrão diurno aproximado: amplitude do perfil médio por hora do dia.
  const hourBuckets = new Map();
  for (let i = 0; i < n; i += 1) {
    const h = hourOfIndex(startMs, i);
    const arr = hourBuckets.get(h) ?? [];
    arr.push(views[i]);
    hourBuckets.set(h, arr);
  }
  let diurnalAmplitude = 0;
  if (hourBuckets.size >= 12) {
    const means = [...hourBuckets.values()].map(
      (arr) => arr.reduce((a, b) => a + b, 0) / arr.length,
    );
    const meanOfMeans = means.reduce((a, b) => a + b, 0) / means.length;
    if (meanOfMeans > 0) {
      diurnalAmplitude = (Math.max(...means) - Math.min(...means)) / meanOfMeans;
    }
  }

  return {
    n,
    total,
    peak,
    peakIdx,
    median: med,
    peakToBase: round(peakToBase, 3),
    peakShare: round(peakShare, 4),
    top3Share: round(top3Share, 4),
    maxRiseRatio: round(maxRiseRatio, 3),
    maxRiseIdx,
    maxDropRatio: round(maxDropRatio, 3),
    maxDropIdx,
    spikeWidth,
    riseHours,
    fallHours,
    maxRampStep: round(maxRampStep, 3),
    maxIdenticalRun,
    runValue,
    runShare: round(runShare, 4),
    window3Share: round(window3Share, 4),
    diurnalAmplitude: round(diurnalAmplitude, 3),
  };
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
