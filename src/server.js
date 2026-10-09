import http from 'node:http';
import { classify, CLASSIFICATIONS, DISCLAIMER } from './classify.js';
import { SeriesValidationError, validateSeries } from './validate.js';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3009;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limitBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('body muito grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Cria o servidor HTTP. O relógio é injetável (testes / evidências).
 */
export function createServer({ clock = () => new Date() } = {}) {
  return http.createServer(async (req, res) => {
    const receivedAt = clock().toISOString();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'conty-deteccao-views',
        receivedAt,
        disclaimer: DISCLAIMER,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/classify') {
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        sendJson(res, 413, { error: 'body excede o limite permitido' });
        return;
      }

      let parsed;
      try {
        parsed = raw.trim() === '' ? null : JSON.parse(raw);
      } catch {
        sendJson(res, 400, {
          error: 'JSON inválido',
          expected: { series: [{ timestamp: 'ISO UTC', views: 'inteiro >= 0' }] },
        });
        return;
      }

      const series = parsed?.series ?? parsed;
      try {
        // Contrato primeiro: violação vira 422 (não classificação).
        if (Array.isArray(series) && series.length > 0 && typeof series[0] === 'object') {
          validateSeries(series);
        }
        const outcome = classify(series, { now: clock() });
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
      } catch (err) {
        if (err instanceof SeriesValidationError) {
          sendJson(res, 422, {
            error: err.message,
            code: err.code,
            contract: {
              description:
                'série cronológica contígua em timestamps UTC horários; views = inteiros seguros não negativos (incrementais por hora)',
              example: [
                { timestamp: '2026-01-05T00:00:00.000Z', views: 120 },
                { timestamp: '2026-01-05T01:00:00.000Z', views: 130 },
              ],
            },
          });
          return;
        }
        sendJson(res, 500, { error: 'erro interno' });
        return;
      }
      return;
    }

    sendJson(res, 404, {
      error: 'rota não encontrada',
      routes: ['GET /health', 'POST /classify'],
    });
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
