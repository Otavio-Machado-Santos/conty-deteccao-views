import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createServer, BODY_LIMIT_BYTES } from '../src/server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
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

// --- Regressões de contrato HTTP ----------------------------------------

test('POST /classify valida SEMPRE o contrato {series:[...]}; corpos inválidos = 422', async () => {
  await withServer(async (base) => {
    const cases = [
      ['objeto vazio', {}],
      ['series ausente', { other: 'x' }],
      ['series null', { series: null }],
      ['series string', { series: 'x' }],
      ['series vazia', { series: [] }],
      ['array numérico', { series: [100, 101, 99, 102, 98, 103] }],
      ['array negativo', { series: [-1] }],
      ['tipos mistos', { series: [{ timestamp: hour(0), views: 1 }, 5] }],
      ['ponto sem chave', { series: [{ timestamp: hour(0) }] }],
    ];
    for (const [name, body] of cases) {
      const res = await fetch(`${base}/classify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 422, `${name} deveria ser 422, veio ${res.status}`);
      const data = await res.json();
      assert.ok(data.error, `${name} deve ter mensagem de erro`);
      assert.ok(data.contract, `${name} deve expor o contrato`);
    }
  });
});

test('POST /classify com JSON sintaticamente inválido devolve 400', async () => {
  await withServer(async (base) => {
    const cases = [
      ['truncado', '{not json'],
      ['vazio', ''],
      ['só espaços', '   '],
      ['quebrado', '{"series": ['],
    ];
    for (const [name, body] of cases) {
      const res = await fetch(`${base}/classify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 400, `${name} deveria ser 400, veio ${res.status}`);
      const data = await res.json();
      assert.match(data.error, /JSON inválido/);
    }
  });
});

test('null literal JSON = 422 (contrato), não 400', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    });
    assert.equal(res.status, 422);
  });
});

test('série válida curta ou de baixo volume ainda retorna 200/inconclusivo', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        series: [1, 2, 3].map((views, i) => ({ timestamp: hour(i), views })),
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.classification, 'inconclusivo');
  });
});

test('timestamps de calendário impossível retornam 422', async () => {
  await withServer(async (base) => {
    for (const ts of [
      '2026-02-30T00:00:00Z',
      '2026-02-29T00:00:00Z',
      'Mon, 05 Jan 2026 00:00:00 Z',
    ]) {
      const res = await fetch(`${base}/classify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          series: [{ timestamp: ts, views: 100 }],
        }),
      });
      assert.equal(res.status, 422, `${ts} deveria ser 422`);
    }
  });
});

test('soma de views acima do total seguro retorna 422', async () => {
  await withServer(async (base) => {
    const huge = Number.MAX_SAFE_INTEGER;
    const views = [huge, 1, 1, 1, 1, 1];
    const res = await fetch(`${base}/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        series: views.map((v, i) => ({ timestamp: hour(i), views: v })),
      }),
    });
    assert.equal(res.status, 422);
    const data = await res.json();
    assert.match(data.error, /total seguro/);
  });
});

// --- Regressões de body limit e Host malformado --------------------------

function rawRequest(base, { path = '/classify', method = 'POST', headers = {}, agent = false, write, end = true }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const url = new URL(base);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method,
        headers,
        agent,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => finish({ status: res.statusCode, body }));
      },
    );
    req.setTimeout(4000, () => {
      req.destroy();
      finish({ error: 'timeout' });
    });
    req.on('error', (error) => finish({ error: error.code, message: error.message }));
    if (write) write(req);
    if (end) req.end();
    return req;
  });
}

test('body acima do limite com Content-Length responde 413 JSON sem ECONNRESET', async () => {
  await withServer(async (base) => {
    const oversized = BODY_LIMIT_BYTES + 101;
    for (const agent of [undefined, false]) {
      const result = await rawRequest(base, {
        headers: {
          'content-type': 'application/json',
          'content-length': oversized,
          ...(agent === false ? { connection: 'close' } : {}),
        },
        agent,
        write: (req) => req.end(Buffer.alloc(oversized, 0x78)),
        end: false,
      });
      assert.equal(result.error, undefined, `CL agent=${agent} não deveria falhar: ${result.error}`);
      assert.equal(result.status, 413, `CL agent=${agent}`);
      const data = JSON.parse(result.body);
      assert.match(data.error, /excede/);
    }
  });
});

test('body acima do limite chunked responde 413 JSON sem ECONNRESET', async () => {
  await withServer(async (base) => {
    for (const agent of [undefined, false]) {
      const result = await rawRequest(base, {
        headers: {
          'content-type': 'application/json',
          ...(agent === false ? { connection: 'close' } : {}),
        },
        agent,
        write: (req) => {
          const chunk = Buffer.alloc(100_000, 0x78);
          for (let i = 0; i < 22; i += 1) req.write(chunk);
        },
      });
      assert.equal(result.error, undefined, `chunked agent=${agent} não deveria falhar: ${result.error}`);
      assert.equal(result.status, 413, `chunked agent=${agent}`);
      const data = JSON.parse(result.body);
      assert.match(data.error, /excede/);
    }
  });
});

test('GET /health continua funcionando após body oversized', async () => {
  await withServer(async (base) => {
    const oversized = BODY_LIMIT_BYTES + 1;
    await rawRequest(base, {
      headers: {
        'content-type': 'application/json',
        'content-length': oversized,
      },
      write: (req) => req.end(Buffer.alloc(oversized, 0x78)),
      end: false,
    });
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });
});

test('Host malformado não derruba o processo; /health responde e segue saudável', async () => {
  const worker = `
    import http from 'node:http';
    import { createServer } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/server.js')).href)};
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/health', headers: { host: '[bad' } },
        (res) => {
          process.stdout.write('STATUS ' + res.statusCode + '\\n');
          res.resume();
          res.on('end', () => {
            const req2 = http.request(
              { hostname: '127.0.0.1', port, path: '/health', headers: { host: '127.0.0.1' } },
              (res2) => {
                process.stdout.write('HEALTH_AFTER ' + res2.statusCode + '\\n');
                res2.resume();
                res2.on('end', () => server.close());
              },
            );
            req2.on('error', (e) => { process.stdout.write('CLIENT2 ' + e.code + '\\n'); server.close(); });
            req2.end();
          });
        },
      );
      req.on('error', (error) => {
        process.stdout.write('CLIENT ' + error.code + '\\n');
        server.close();
      });
      req.end();
    });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', worker], {
    encoding: 'utf8',
    timeout: 5000,
    cwd: ROOT,
  });
  assert.equal(result.status, 0, `processo não deveria morrer: ${result.stderr}`);
  assert.match(result.stdout, /STATUS \d+/);
  assert.match(result.stdout, /HEALTH_AFTER 200/);
});
