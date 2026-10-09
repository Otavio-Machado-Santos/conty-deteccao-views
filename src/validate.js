/**
 * Contrato da série temporal:
 * - lista de pontos cronologicamente ordenados;
 * - timestamps UTC contíguos com passo de 1 hora;
 * - `views` = inteiros seguros não negativos (views incrementais daquela hora).
 */

const HOUR_MS = 3_600_000;

export class SeriesValidationError extends Error {
  constructor(message, code = 'invalid_series') {
    super(message);
    this.name = 'SeriesValidationError';
    this.code = code;
  }
}

function parseUtcTimestamp(value, index) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new SeriesValidationError(`timestamp[${index}] inválido`);
    }
    return value.getTime();
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SeriesValidationError(
      `timestamp[${index}] deve ser string ISO UTC ou Date`,
    );
  }
  const raw = value.trim();
  const isUtc =
    raw.endsWith('Z') ||
    raw.endsWith('+00:00') ||
    raw.endsWith('+0000');
  if (!isUtc) {
    throw new SeriesValidationError(
      `timestamp[${index}] deve estar em UTC (terminar em Z ou +00:00)`,
    );
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new SeriesValidationError(`timestamp[${index}] inválido: ${raw}`);
  }
  return ms;
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
 * Valida e normaliza uma série no formato da API:
 *   [{ timestamp: string UTC | Date, views: number }, ...]
 *
 * Retorna { startMs, stepMs, views } já checados.
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
    if (point === null || typeof point !== 'object') {
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

  return {
    startMs: parseUtcTimestamp(series[0].timestamp, 0),
    stepMs: HOUR_MS,
    views,
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
