import http from 'node:http';
import { classify, CLASSIFICATIONS, DISCLAIMER } from './classify.js';
import { SeriesValidationError, validateSeries } from './validate.js';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3009;

/** Limite de corpo em bytes. Acima disso: 413 com JSON real (sem socket reset). */
export const BODY_LIMIT_BYTES = 2_000_000;

const CONTRACT = {
  description:
    'série cronológica contígua em timestamps UTC horários; views = inteiros seguros não negativos (incrementais por hora)',
  example: [
    { timestamp: '2026-01-05T00:00:00.000Z', views: 120 },
    { timestamp: '2026-01-05T01:00:00.000Z', views: 130 },
  ],
  shape: { series: [{ timestamp: 'ISO UTC', views: 'inteiro >= 0' }] },
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Responde 413 JSON real e drena o restante do corpo sem acumular.
 * Só encerra a resposta depois que o request terminar — res.end() antes
 * disso faz o Node destruir o socket e o cliente recebe ECONNRESET.
 */
function send413AndDrain(req, res, message) {
  const payload = JSON.stringify({ error: message }, null, 2);
  res.writeHead(413, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.write(payload);
  req.on('data', () => {});
  req.on('end', () => res.end());
  req.on('error', () => res.end());
  req.resume();
}

function contractError(res, message, code = 'invalid_series') {
  sendJson(res, 422, {
    error: message,
    code,
    contract: CONTRACT,
  });
}

/**
 * Lê o corpo com limite. Nunca faz req.destroy() antes de o chamador
 * conseguir responder: em overflow resolve { ok:false, reason:'too_large' }
 * e descarta o restante sem acumular. Rejeita cedo quando Content-Length
 * já excede o limite.
 */
function readBody(req, limitBytes = BODY_LIMIT_BYTES) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limitBytes) {
      resolve({ ok: false, reason: 'too_large' });
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        chunks.length = 0;
        finish({ ok: false, reason: 'too_large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        finish({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
      }
    });
    req.on('error', () => finish({ ok: false, reason: 'read_error' }));
    req.on('aborted', () => finish({ ok: false, reason: 'aborted' }));
  });
}

/**
 * Extrai o pathname sem depender do header Host (que pode ser malformado).
 * Base fixa local: uma requisição com Host inválido não derruba o processo.
 */
function safePathname(rawUrl) {
  try {
    const url = new URL(rawUrl ?? '/', 'http://127.0.0.1');
    return url.pathname;
  } catch {
    return null;
  }
}

/**
 * Extrai o array `series` do corpo público `{ series: [...] }`.
 * Fora desse formato: erro de contrato (não classificação).
 */
function extractSeries(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      error:
        'corpo deve ser um objeto JSON no formato { series: [{ timestamp, views }, ...] }',
    };
  }
  if (!('series' in parsed)) {
    return { error: 'campo obrigatório "series" ausente' };
  }
  return { series: parsed.series };
}

/**
 * Cria o servidor HTTP. O relógio é injetável (testes / evidências).
 */
export function createServer({ clock = () => new Date() } = {}) {
  return http.createServer(async (req, res) => {
    try {
      let receivedAt;
      try {
        receivedAt = clock().toISOString();
      } catch {
        receivedAt = new Date().toISOString();
      }

      const pathname = safePathname(req.url);
      if (pathname === null) {
        sendJson(res, 400, { error: 'URL inválida' });
        return;
      }

      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'conty-deteccao-views',
          receivedAt,
          disclaimer: DISCLAIMER,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/classify') {
        const raw = await readBody(req);
        if (!raw.ok) {
          if (raw.reason === 'too_large') {
            send413AndDrain(
              req,
              res,
              `body excede o limite de ${BODY_LIMIT_BYTES} bytes`,
            );
            return;
          }
          sendJson(res, 400, { error: 'falha ao ler o corpo da requisição' });
          return;
        }

        let parsed;
        try {
          // Vazio / só espaços / truncado também lançam SyntaxError → 400.
          parsed = JSON.parse(raw.body);
        } catch {
          sendJson(res, 400, {
            error: 'JSON inválido',
            expected: CONTRACT.shape,
          });
          return;
        }

        const extracted = extractSeries(parsed);
        if (extracted.error) {
          contractError(res, extracted.error, 'invalid_body');
          return;
        }

        // Contrato SEMPRE antes de classificar — sem pular validação pelo
        // tipo do primeiro elemento.
        try {
          validateSeries(extracted.series);
        } catch (err) {
          if (err instanceof SeriesValidationError) {
            contractError(res, err.message, err.code);
            return;
          }
          sendJson(res, 500, { error: 'erro interno' });
          return;
        }

        const outcome = classify(extracted.series, { now: clock() });

        sendJson(res, 200, {
          classification: outcome.classification,
          reason: outcome.reason,
          shape: outcome.shape,
          signals: outcome.signals,
          rawMetrics: outcome.rawMetrics,
          flags: outcome.flags,
          thresholds: outcome.thresholds,
          disclaimer: outcome.disclaimer ?? DISCLAIMER,
          receivedAt,
          note:
            outcome.classification === CLASSIFICATIONS.SUSPICIOUS
              ? 'Classificação de risco para triagem humana. Não é prova de fraude nem atribuição de autoria.'
              : 'Séries horárias não separam humanos de bots com certeza; tráfego pago legítimo e campanhas agendadas podem se parecer com pico comprado.',
        });
        return;
      }

      sendJson(res, 404, {
        error: 'rota não encontrada',
        routes: ['GET /health', 'POST /classify'],
      });
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'erro interno' });
      } else {
        res.end();
      }
    }
  });
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('src/server.js') || process.argv[1].endsWith('server.js'));

if (isMain) {
  const host = process.env.HOST ?? DEFAULT_HOST;
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`conty-deteccao-views ouvindo em http://${host}:${port}`);
  });
}
