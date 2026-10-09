import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

const hour = (i) =>
  new Date(Date.parse('2026-01-05T00:00:00.000Z') + i * 3_600_000).toISOString();

function series(views) {
  return views.map((views, i) => ({ timestamp: hour(i), views }));
}

function jitter(i) {
  return ((i * 17) % 5) - 2;
}

async function withServer(fn, options = {}) {
  const server = createServer(options);
  const base = await listen(server);
  try {
    return await fn(base);
  } finally {
    await close(server);
  }
}

test('POST /classify devolve classificação, motivo em português e sinais', async () => {
  await withServer(async (base) => {
    const views = [];
    for (let i = 0; i < 48; i += 1) {
      views.push(i >= 20 && i < 22 ? 2500 + jitter(i) : 100 + jitter(i));
    }
    const res = await fetch(`${base}/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ series: series(views) }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.classification, 'suspeito');
    assert.equal(typeof body.reason, 'string');
    assert.ok(body.reason.length > 40);
    assert.ok(body.signals.peakToBase);
    assert.ok(body.signals.concentration);
    assert.ok(body.signals.exactRepetition);
    assert.ok(body.signals.rampShape);
    assert.match(body.disclaimer, /não prova|não é prova/i);
  });
});

test('POST /classify distingue viral orgânico de pico comprado', async () => {
  await withServer(async (base) => {
    const viral = [];
    for (let i = 0; i < 48; i += 1) {
      let v = 100;
      if (i >= 10 && i < 18) {
        const t = (i - 10) / 8;
        v = 100 + 1100 * (t * t * (3 - 2 * t));
      } else if (i >= 18 && i < 32) {
        const t = (i - 18) / 14;
        v = 1200 - 1100 * (t * t * (3 - 2 * t));
      }
      viral.push(Math.round(v) + jitter(i));
    }
    const bought = [];
    for (let i = 0; i < 48; i += 1) {
      bought.push(i >= 20 && i < 22 ? 2500 + jitter(i) : 100 + jitter(i));
    }

    const post = async (payload) => {
      const res = await fetch(`${base}/classify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ series: series(payload) }),
      });
      assert.equal(res.status, 200);
      return res.json();
    };

    const viralBody = await post(viral);
    const boughtBody = await post(bought);
    assert.equal(viralBody.classification, 'plausivel');
    assert.equal(boughtBody.classification, 'suspeito');
    assert.notEqual(viralBody.classification, boughtBody.classification);
  });
});

test('POST /classify rejeita série não contígua com 422 e contrato', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        series: [
          { timestamp: hour(0), views: 10 },
          { timestamp: hour(2), views: 10 },
        ],
      }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.match(body.error, /contíguo/i);
    assert.ok(body.contract);
  });
});

test('POST /classify com JSON inválido devolve 400', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
  });
});

test('GET /health responde ok com relógio injetado', async () => {
  const fixed = new Date('2026-10-09T15:00:00.000Z');
  await withServer(
    async (base) => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.receivedAt, fixed.toISOString());
    },
    { clock: () => fixed },
  );
});

test('rota desconhecida devolve 404 com lista de rotas', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.routes.includes('POST /classify'));
  });
});
