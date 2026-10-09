/**
 * Contrato da série temporal:
 * - lista de pontos cronologicamente ordenados;
 * - timestamps UTC contíguos com passo de 1 hora;
 * - `views` = inteiros seguros não negativos (views incrementais daquela hora);
 * - a soma total deve caber em Number.MAX_SAFE_INTEGER.
 */

const HOUR_MS = 3_600_000;

/** Limite exato da soma das views. Acima disso o total não é representável. */
export const MAX_SAFE_TOTAL = Number.MAX_SAFE_INTEGER;

export class SeriesValidationError extends Error {
  constructor(message, code = 'invalid_series') {
    super(message);
    this.name = 'SeriesValidationError';
    this.code = code;
  }
}

/**
 * ISO UTC estrito: `YYYY-MM-DDTHH:mm:ss(.sss)?` + `Z` ou `+00:00`.
 * Formatos RFC/HTTP, offsets não-UTC e datas não ISO são rejeitados.
 * Sem trim: espaço anterior/posterior invalida o timestamp.
 */
const ISO_UTC_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|\+00:00)$/;

/**
 * Constrói o timestamp UTC sem o remapeamento de Date.UTC para anos 0..99
 * (que vira 1900..1999). Usa data de referência + setUTCFullYear com todos
 * os componentes civis, e confere por roundtrip que o calendário existe.
 */
function utcFromComponents(year, month, day, hour, minute, second, ms, raw, index) {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, ms);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day ||
    d.getUTCHours() !== hour ||
    d.getUTCMinutes() !== minute ||
    d.getUTCSeconds() !== second ||
    d.getUTCMilliseconds() !== ms
  ) {
    throw new SeriesValidationError(
      `timestamp[${index}] não corresponde a uma data civil existente: ${raw}`,
    );
  }
  return d.getTime();
}

/**
 * Converte e valida um timestamp ISO UTC estrito, sem normalização
 * silenciosa de calendário (fev 30, fev 29 em ano não bissexto, etc.)
 * e sem remapeamento de anos 0..99.
 */
function parseUtcTimestamp(value, index) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new SeriesValidationError(`timestamp[${index}] inválido`);
    }
    const ms = value.getTime();
    if (ms % HOUR_MS !== 0) {
      throw new SeriesValidationError(
        `timestamp[${index}] deve ser início de hora UTC (alinhado à hora cheia)`,
      );
    }
    return ms;
  }
  if (typeof value !== 'string' || value === '') {
    throw new SeriesValidationError(
      `timestamp[${index}] deve ser string ISO UTC ou Date`,
    );
  }
  // Sem trim: espaço anterior/posterior viola o ISO estrito do contrato.
  const raw = value;
  const match = ISO_UTC_RE.exec(raw);
  if (!match) {
    throw new SeriesValidationError(
      `timestamp[${index}] deve ser ISO UTC estrito (YYYY-MM-DDTHH:mm:ss(.sss)?Z ou +00:00), recebido ${raw}`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const msPart = match[7] ? Number(match[7].padEnd(3, '0')) : 0;

  if (minute !== 0 || second !== 0 || msPart !== 0) {
    throw new SeriesValidationError(
      `timestamp[${index}] deve ser início de hora UTC (alinhado à hora cheia), recebido ${raw}`,
    );
  }

  return utcFromComponents(year, month, day, hour, minute, second, msPart, raw, index);
}

function assertIncrementalViews(views, index) {
  if (typeof views !== 'number' || !Number.isFinite(views)) {
    throw new SeriesValidationError(`views[${index}] deve ser número finito`);
  }
  if (!Number.isInteger(views)) {
    throw new SeriesValidationError(
      `views[${index}] deve ser inteiro (incremental por hora), recebido ${views}`,
    );
  }
  if (views < 0) {
    throw new SeriesValidationError(
      `views[${index}] deve ser não negativo, recebido ${views}`,
    );
  }
  if (!Number.isSafeInteger(views)) {
    throw new SeriesValidationError(
      `views[${index}] deve ser inteiro seguro (≤ Number.MAX_SAFE_INTEGER)`,
    );
  }
}

/**
 * Soma segura das views. Rejeita explicitamente séries cujo total excede
 * Number.MAX_SAFE_INTEGER, antes de qualquer métrica derivada.
 */
export function sumViewsSafe(views) {
  let total = 0;
  for (let i = 0; i < views.length; i += 1) {
    const v = views[i];
    if (total > MAX_SAFE_TOTAL - v) {
      throw new SeriesValidationError(
        `soma das views excede o total seguro (Number.MAX_SAFE_INTEGER = ${MAX_SAFE_TOTAL}); limite documentado no README`,
        'unsafe_total',
      );
    }
    total += v;
  }
  return total;
}

/**
 * Valida e normaliza uma série no formato da API:
 *   [{ timestamp: string UTC | Date, views: number }, ...]
 *
 * Retorna { startMs, stepMs, views, total } já checados.
 */
export function validateSeries(series) {
  if (!Array.isArray(series)) {
    throw new SeriesValidationError('series deve ser um array de pontos');
  }
  if (series.length === 0) {
    throw new SeriesValidationError('series não pode ser vazia');
  }

  const views = [];
  let prevMs = null;

  for (let i = 0; i < series.length; i += 1) {
    const point = series[i];
    if (point === null || typeof point !== 'object' || Array.isArray(point)) {
      throw new SeriesValidationError(`series[${i}] deve ser objeto`);
    }
    if (!('timestamp' in point) || !('views' in point)) {
      throw new SeriesValidationError(
        `series[${i}] precisa das chaves timestamp e views`,
      );
    }
    const ms = parseUtcTimestamp(point.timestamp, i);
    assertIncrementalViews(point.views, i);

    if (i === 0) {
      if (ms % HOUR_MS !== 0) {
        throw new SeriesValidationError(
          `timestamp[${i}] deve ser início de hora UTC (alinhado à hora cheia)`,
        );
      }
    } else if (ms - prevMs !== HOUR_MS) {
      throw new SeriesValidationError(
        `timestamp[${i}] não é contíguo: passo de ${(ms - prevMs) / 60000} minutos após o ponto ${i - 1}, esperado 60 minutos UTC`,
      );
    }

    prevMs = ms;
    views.push(point.views);
  }

  const total = sumViewsSafe(views);

  return {
    startMs: parseUtcTimestamp(series[0].timestamp, 0),
    stepMs: HOUR_MS,
    views,
    total,
  };
}

/**
 * Expande formato compacto do dataset (start + views) para o formato da API.
 */
export function expandCompact({ start, views }) {
  if (typeof start !== 'string') {
    throw new SeriesValidationError('start deve ser string ISO UTC');
  }
  if (!Array.isArray(views)) {
    throw new SeriesValidationError('views deve ser array de inteiros');
  }
  const startMs = parseUtcTimestamp(start, 0);
  return views.map((value, i) => ({
    timestamp: new Date(startMs + i * HOUR_MS).toISOString(),
    views: value,
  }));
}
