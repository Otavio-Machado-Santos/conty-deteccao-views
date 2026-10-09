import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPrng, randomInt, gaussian } from './prng.js';
import { expandCompact, validateSeries } from './validate.js';

export const SEED = 20261009;
export const DATASET_VERSION = 1;

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATASET_PATH = join(__dirname, '..', 'dataset', 'series.json');

/**
 * Perfis sintéticos.
 * Rótulos são SINTÉTICOS (regras do gerador, não audiência real).
 * Legítimo ≠ "comprovadamente humano"; suspeito ≠ "comprovadamente fraude".
 */
export const PROFILES = {
  diurno: {
    label: 'legitimo',
    count: 16,
    hours: 48,
    description: 'padrão diurno com ruído; tráfego orgânico cotidiano',
  },
  viral_organico: {
    label: 'legitimo',
    count: 16,
    hours: 48,
    description: 'viral com subida e queda graduais (não deve ser acusado)',
  },
  campanha_sustentada: {
    label: 'legitimo',
    count: 14,
    hours: 48,
    description: 'campanha paga legítima com platô elevado de várias horas',
  },
  baixo_volume: {
    label: 'legitimo',
    count: 12,
    hours: 36,
    description: 'volume baixo; classificador deve abstir',
  },
  evento_rapido: {
    label: 'legitimo',
    count: 14,
    hours: 36,
    description: 'evento legítimo de curta duração (TV/live); caso preferir não acusar',
  },
  compra_abrupta: {
    label: 'suspeito',
    count: 16,
    hours: 48,
    description: 'pico comprado: subida e queda abruptas em 1–2 horas',
  },
  repeticao_mecanica: {
    label: 'suspeito',
    count: 14,
    hours: 48,
    description: 'ritmo mecânico: valores idênticos repetidos com volume',
  },
};

function clampNonNegInt(value) {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded) || rounded < 0) return 0;
  return Math.min(rounded, Number.MAX_SAFE_INTEGER);
}

function noiseViews(prng, center, spread) {
  return clampNonNegInt(center + gaussian(prng, 0, spread));
}

function genDiurno(prng, hours) {
  const base = 80 + prng() * 120;
  const amplitude = 0.25 + prng() * 0.35;
  const startHour = randomInt(prng, 0, 24);
  const views = [];
  for (let i = 0; i < hours; i += 1) {
    const h = (startHour + i) % 24;
    // Pico de audiência entre 18h e 22h UTC, vale entre 3h e 6h.
    const diurnal = 0.55 + 0.45 * Math.sin(((h - 9) / 24) * 2 * Math.PI);
    const center = base * (1 + amplitude * (diurnal - 0.55) * 2);
    views.push(noiseViews(prng, center, center * 0.08));
  }
  return views;
}

function genViralOrganico(prng, hours) {
  const base = 60 + prng() * 80;
  const peakMult = 6 + prng() * 12; // 6×–18× a base
  const peakAt = 16 + randomInt(prng, 0, 10); // pico mais tarde, rampa longa
  const riseSpan = 8 + randomInt(prng, 0, 6); // subida 8–13h
  const fallSpan = 10 + randomInt(prng, 0, 8); // descida 10–17h
  const views = [];
  for (let i = 0; i < hours; i += 1) {
    let factor = 1;
    if (i < peakAt - riseSpan) {
      factor = 1;
    } else if (i <= peakAt) {
      const t = (i - (peakAt - riseSpan)) / riseSpan; // 0→1
      // curva suave (ease-in-out)
      const smooth = t * t * (3 - 2 * t);
      factor = 1 + (peakMult - 1) * smooth;
    } else if (i <= peakAt + fallSpan) {
      const t = (i - peakAt) / fallSpan; // 0→1
      const smooth = t * t * (3 - 2 * t);
      factor = peakMult - (peakMult - 1) * smooth;
    } else {
      factor = 1;
    }
    views.push(noiseViews(prng, base * factor, base * factor * 0.06));
  }
  return views;
}

function genCampanhaSustentada(prng, hours) {
  const base = 100 + prng() * 100;
  const lift = 1.8 + prng() * 2.2; // 1.8×–4×
  const start = 6 + randomInt(prng, 0, 8);
  const duration = 10 + randomInt(prng, 0, 8);
  const edge = 2 + randomInt(prng, 0, 2);
  const views = [];
  for (let i = 0; i < hours; i += 1) {
    let factor = 1;
    if (i < start) {
      factor = 1;
    } else if (i < start + edge) {
      factor = 1 + (lift - 1) * ((i - start + 1) / edge);
    } else if (i < start + duration - edge) {
      factor = lift;
    } else if (i < start + duration) {
      factor = 1 + (lift - 1) * ((start + duration - i) / edge);
    }
    views.push(noiseViews(prng, base * factor, base * factor * 0.05));
  }
  return views;
}

function genBaixoVolume(prng, hours) {
  const views = [];
  for (let i = 0; i < hours; i += 1) {
    views.push(randomInt(prng, 0, 14));
  }
  return views;
}

function genEventoRapido(prng, hours) {
  // Evento legítimo curto: pico real, mas com cauda e sem "lance" mecânico.
  // Série desenhada para ser ambígua — o classificador deve preferir não acusar.
  const base = 120 + prng() * 100;
  const peakMult = 2.5 + prng() * 2.8; // 2.5×–5.3×
  const peakAt = 12 + randomInt(prng, 0, 8);
  const width = 1 + randomInt(prng, 0, 2); // 1–3 horas no pico
  const views = [];
  for (let i = 0; i < hours; i += 1) {
    let factor = 1;
    const dist = i - peakAt;
    if (dist >= 0 && dist < width) {
      factor = peakMult;
      // decaimento parcial dentro do pico
      if (width > 1) factor *= 1 - 0.15 * dist;
    } else if (dist >= width && dist < width + 6) {
      // cauda de buzz pós-evento
      factor = 1 + (peakMult - 1) * 0.35 * (1 - (dist - width) / 6);
    } else if (dist < 0 && dist >= -3) {
      // aquecimento leve
      factor = 1 + (peakMult - 1) * 0.12 * (1 + dist / 3);
    }
    views.push(noiseViews(prng, base * factor, base * factor * 0.07));
  }
  return views;
}

function genCompraAbrupta(prng, hours) {
  const base = 40 + prng() * 60;
  const spikeMult = 15 + prng() * 45; // 15×–60× — "lance" de compra
  const spikeAt = 12 + randomInt(prng, 0, 16);
  const width = 1 + randomInt(prng, 0, 2); // 1–3 horas
  const views = [];
  for (let i = 0; i < hours; i += 1) {
    let center = base;
    const dist = i - spikeAt;
    if (dist >= 0 && dist < width) {
      center = base * spikeMult;
    } else if (dist === width) {
      // queda abrupta imediata, com micro-resíduo
      center = base * (1 + prng() * 0.3);
    }
    views.push(noiseViews(prng, center, center * 0.04));
  }
  return views;
}

function genRepeticaoMecanica(prng, hours) {
  const base = 30 + prng() * 50;
  const stamped = 80 + prng() * 220; // valor "carimbado"
  const start = 8 + randomInt(prng, 0, 10);
  const duration = 5 + randomInt(prng, 0, 5); // 5–9 horas idênticas
  const views = [];
  for (let i = 0; i < hours; i += 1) {
    if (i >= start && i < start + duration) {
      views.push(clampNonNegInt(stamped));
    } else {
      views.push(noiseViews(prng, base, base * 0.1));
    }
  }
  return views;
}

const GENERATORS = {
  diurno: genDiurno,
  viral_organico: genViralOrganico,
  campanha_sustentada: genCampanhaSustentada,
  baixo_volume: genBaixoVolume,
  evento_rapido: genEventoRapido,
  compra_abrupta: genCompraAbrupta,
  repeticao_mecanica: genRepeticaoMecanica,
};

/**
 * Gera o dataset completo de forma determinística a partir da seed.
 * O relógio é injetado apenas no metadado `generatedAt` (não afeta as séries).
 */
export function buildDataset({ seed = SEED, clock = () => new Date() } = {}) {
  const prng = createPrng(seed);
  const series = [];
  // Base fixa de datas para que o dataset seja reprodutível byte a byte
  // (o conteúdo das séries não depende do relógio; só o metadado usa o clock).
  const baseStartMs = Date.parse('2026-01-05T00:00:00.000Z');

  for (const [profile, cfg] of Object.entries(PROFILES)) {
    const generate = GENERATORS[profile];
    for (let k = 0; k < cfg.count; k += 1) {
      const views = generate(prng, cfg.hours);
      const startMs = baseStartMs + (series.length * 3_600_000);
      const start = new Date(startMs).toISOString();
      const compact = { start, views };
      // valida o contrato antes de gravar
      validateSeries(expandCompact(compact));
      series.push({
        id: `${profile}-${String(k).padStart(3, '0')}`,
        profile,
        label: cfg.label,
        start,
        views,
      });
    }
  }

  return {
    meta: {
      seed,
      datasetVersion: DATASET_VERSION,
      generatedAt: clock().toISOString(),
      labelNote:
        'Rótulos sintéticos gerados por regras deste script. A taxa de falso positivo vale apenas para este conjunto; não estima produção real.',
      profiles: Object.fromEntries(
        Object.entries(PROFILES).map(([k, v]) => [
          k,
          { label: v.label, count: v.count, description: v.description },
        ]),
      ),
    },
    series,
  };
}

/**
 * Serialização estável (ordem de chaves fixa) para comparação byte a byte.
 * `generatedAt` fica fora do payload canônico.
 */
export function canonicalizeDataset(dataset) {
  return {
    meta: {
      seed: dataset.meta.seed,
      datasetVersion: dataset.meta.datasetVersion,
      labelNote: dataset.meta.labelNote,
      profiles: dataset.meta.profiles,
    },
    series: dataset.series,
  };
}

export function serializeDataset(dataset) {
  return `${JSON.stringify(canonicalizeDataset(dataset), null, 2)}\n`;
}

/**
 * Publicação atômica: cria arquivo temporário realmente exclusivo
 * (randomUUID + openSync 'wx') na MESMA pasta, escreve pelo fd que esta
 * chamada abriu, fecha e faz rename. Leitores concorrentes nunca veem
 * JSON parcial, mesmo com worker_threads compartilhando PID e clock.
 * Em falha, remove SOMENTE o temporário que esta chamada criou.
 */
export function writeJsonAtomic(path, body) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
  let fd = null;
  let owned = false;
  try {
    // 'wx' = criação exclusiva. Ownership de ESTA chamada só existe se o
    // openSync passar; em EEXIST o arquivo é preexistente e não é nosso.
    fd = openSync(tmp, 'wx');
    owned = true;
    writeFileSync(fd, body, 'utf8');
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // fd já fechado
      }
    }
    // Remove somente o temporário que ESTA chamada criou.
    if (owned) {
      try {
        unlinkSync(tmp);
      } catch {
        // já ausente
      }
    }
    throw err;
  }
}

export function generateDatasetFile(path = DEFAULT_DATASET_PATH, options = {}) {
  const dataset = buildDataset(options);
  const body = serializeDataset(dataset);
  writeJsonAtomic(path, body);
  return { dataset, body, path };
}

export function loadDataset(path = DEFAULT_DATASET_PATH) {
  if (!existsSync(path)) {
    throw new Error(`Dataset não encontrado em ${path}. Rode npm run generate:evaluate.`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Expande uma entrada do dataset para o formato da API (pontos com timestamp)
 * e valida o contrato antes de devolver.
 */
export function expandDatasetSeries(entry) {
  const points = expandCompact({ start: entry.start, views: entry.views });
  validateSeries(points);
  return points;
}
