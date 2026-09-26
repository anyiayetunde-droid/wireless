'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');
const { startServer } = require('../server');
const mock = require('../lib/drivers/mock');

async function withServer(fn) {
  const app = await startServer({ port: 0, pin: '1234', driver: 'mock' });
  try {
    await fn(app);
  } finally {
    mock.reset();
    await closeSockets();
    await app.close();
  }
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: pathname }, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      })
      .on('error', reject);
  });
}

function getText(port, pathname) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: pathname }, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      })
      .on('error', reject);
  });
}

function getBuffer(port, pathname) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: pathname }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      })
      .on('error', reject);
  });
}

const liveSockets = [];

function connectWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    liveSockets.push(ws);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function sendAndWait(ws, obj) {
  return new Promise((resolve) => {
    const onMsg = (data) => {
      ws.off('message', onMsg);
      resolve(JSON.parse(data.toString()));
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify(obj));
  });
}

async function closeSockets() {
  for (const ws of liveSockets.splice(0)) ws.terminate();
  await new Promise((r) => setTimeout(r, 30));
}

test('serves the phone page, host page and status API', async () => {
  await withServer(async (app) => {
    const index = await getText(app.port, '/');
    assert.strictEqual(index.status, 200);
    assert.match(index.body, /Wireless/);

    const host = await getText(app.port, '/host');
    assert.strictEqual(host.status, 200);
    assert.match(host.body, /QR code/);

    const status = await getJson(app.port, '/api/status');
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.body.pin, '1234');
    assert.strictEqual(status.body.driver.name, 'mock');
    assert.ok(Array.isArray(status.body.urls));

    const qr = await getText(app.port, '/qr.png');
    assert.strictEqual(qr.status, 200);

    const missing = await getText(app.port, '/nope.html');
    assert.strictEqual(missing.status, 404);
  });
});

test('rejects a wrong PIN and closes after repeated attempts', { timeout: 10000 }, async () => {
  await withServer(async (app) => {
    const ws = await connectWs(app.port);
    const bad = await sendAndWait(ws, { t: 'hello', pin: '0000' });
    assert.strictEqual(bad.ok, false);

    // Attempts beyond the limit close the socket.
    let closed = false;
    ws.on('close', () => (closed = true));
    for (let i = 0; i < 5; i++) {
      ws.send(JSON.stringify({ t: 'hello', pin: '0000' }));
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(closed, true);
  });
});

test('accepts a valid PIN and forwards key/text/combo/mouse events', async () => {
  await withServer(async (app) => {
    const ws = await connectWs(app.port);
    const hello = await sendAndWait(ws, { t: 'hello', pin: '1234' });
    assert.strictEqual(hello.ok, true);

    mock.reset();

    ws.send(JSON.stringify({ t: 'key', k: 'a' }));
    ws.send(JSON.stringify({ t: 'key', k: 'A' }));
    ws.send(JSON.stringify({ t: 'key', k: 'Enter' }));
    ws.send(JSON.stringify({ t: 'text', s: 'hello world' }));
    ws.send(JSON.stringify({ t: 'combo', mods: ['Control'], k: 'c' }));
    ws.send(JSON.stringify({ t: 'mouse', dx: 10, dy: -5 }));
    ws.send(JSON.stringify({ t: 'mouse', btn: 'left', down: true }));
    ws.send(JSON.stringify({ t: 'scroll', dy: -2 }));

    await new Promise((r) => setTimeout(r, 250));

    // Key events preserve their order (single key queue); mouse events run
    // on a separate queue and may interleave.
    const keys = mock.events.filter((e) => e.kind.startsWith('tap') || e.kind === 'typeText');
    const mouse = mock.events.filter((e) => ['mouseMove', 'mouseButton', 'scroll'].includes(e.kind));
    const keyKinds = keys.map((e) => e.kind + ':' + JSON.stringify(e.payload));
    assert.deepStrictEqual(keyKinds, [
      'tapChar:"a"',
      'tapChar:"A"',
      'tapKey:"Enter"',
      'typeText:"hello world"',
      'tapCombo:{"mods":["Control"],"key":"c"}',
    ]);
    const mouseKinds = mouse.map((e) => e.kind + ':' + JSON.stringify(e.payload));
    assert.deepStrictEqual(mouseKinds, [
      'mouseMove:{"dx":10,"dy":-5}',
      'mouseButton:{"btn":"left","down":true}',
      'scroll:-2',
    ]);
  });
});

test('maps newline key to Enter and ignores unknown messages', async () => {
  await withServer(async (app) => {
    const ws = await connectWs(app.port);
    await sendAndWait(ws, { t: 'hello', pin: '1234' });
    mock.reset();

    ws.send(JSON.stringify({ t: 'key', k: '\n' }));
    ws.send(JSON.stringify({ t: 'bogus', x: 1 }));
    ws.send(JSON.stringify({ t: 'key', k: 'F12' }));
    ws.send(JSON.stringify({ t: 'key', k: 'ZZ' })); // 2 chars, not special -> ignored

    await new Promise((r) => setTimeout(r, 150));

    const kinds = mock.events.map((e) => e.kind + ':' + JSON.stringify(e.payload));
    assert.deepStrictEqual(kinds, ['tapKey:"Enter"', 'tapKey:"F12"']);
  });
});

test('routes laptop input to the phone receiver over the local driver', async () => {
  await withServer(async (app) => {
    // The phone app connects as a receiver.
    const receiver = await connectWs(app.port);
    const recvHello = await sendAndWait(receiver, { t: 'hello', pin: '1234', role: 'receiver' });
    assert.strictEqual(recvHello.ok, true);

    // The laptop connects as a controller.
    const laptop = await connectWs(app.port);
    const laptopHello = await sendAndWait(laptop, { t: 'hello', pin: '1234', role: 'laptop' });
    assert.strictEqual(laptopHello.ok, true);

    const status = await getJson(app.port, '/api/status');
    assert.strictEqual(status.body.receiver, true);

    const received = [];
    const recv = (data) => received.push(JSON.parse(data.toString()));
    receiver.on('message', recv);

    mock.reset();

    laptop.send(JSON.stringify({ t: 'key', k: 'h' }));
    laptop.send(JSON.stringify({ t: 'key', k: 'Enter' }));
    laptop.send(JSON.stringify({ t: 'combo', mods: ['Control'], k: 'c' }));
    laptop.send(JSON.stringify({ t: 'text', s: 'hi there' }));
    laptop.send(JSON.stringify({ t: 'keydown', k: 'a', mods: [] }));
    laptop.send(JSON.stringify({ t: 'keyup', k: 'a', mods: [] }));
    laptop.send(JSON.stringify({ t: 'nav', a: 'back' }));
    laptop.send(JSON.stringify({ t: 'phone', g: 'tap', x: 0.5, y: 0.8 }));
    laptop.send(JSON.stringify({ t: 'phone', g: 'scroll', dy: 3 }));

    await new Promise((r) => setTimeout(r, 200));

    // Everything went to the receiver; the local (mock) driver saw nothing.
    assert.strictEqual(mock.events.length, 0);
    const kinds = received.map((m) => m.t + ':' + JSON.stringify(m));
    assert.ok(kinds.includes('key:{"t":"key","k":"h"}'), 'missing forwarded key');
    assert.ok(kinds.includes('key:{"t":"key","k":"Enter"}'), 'missing forwarded special key');
    assert.ok(kinds.includes('combo:{"t":"combo","mods":["Control"],"k":"c"}'), 'missing forwarded combo');
    assert.ok(kinds.includes('text:{"t":"text","s":"hi there"}'), 'missing forwarded text');
    assert.ok(kinds.includes('keydown:{"t":"keydown","k":"a","mods":[]}'), 'missing forwarded keydown');
    assert.ok(kinds.includes('keyup:{"t":"keyup","k":"a","mods":[]}'), 'missing forwarded keyup');
    assert.ok(kinds.includes('nav:{"t":"nav","a":"back"}'), 'missing forwarded nav');
    assert.ok(kinds.includes('phone:{"t":"phone","g":"tap","x":0.5,"y":0.8}'), 'missing forwarded tap');
    assert.ok(kinds.includes('phone:{"t":"phone","g":"scroll","dy":3}'), 'missing forwarded scroll');

    receiver.off('message', recv);
  });
});

test('laptop input falls back to the local driver when no receiver is connected', async () => {
  await withServer(async (app) => {
    const laptop = await connectWs(app.port);
    await sendAndWait(laptop, { t: 'hello', pin: '1234', role: 'laptop' });
    mock.reset();

    laptop.send(JSON.stringify({ t: 'key', k: 'x' }));
    laptop.send(JSON.stringify({ t: 'key', k: 'F5' }));
    laptop.send(JSON.stringify({ t: 'keydown', k: 'z', mods: ['Control'] }));
    laptop.send(JSON.stringify({ t: 'combo', mods: ['Alt'], k: 'Tab' }));
    laptop.send(JSON.stringify({ t: 'nav', a: 'home' })); // no receiver -> dropped

    await new Promise((r) => setTimeout(r, 200));

    const kinds = mock.events.map((e) => e.kind + ':' + JSON.stringify(e.payload));
    assert.deepStrictEqual(kinds, [
      'tapChar:"x"',
      'tapKey:"F5"',
      'tapCombo:{"mods":["Control"],"key":"z"}',
      'tapCombo:{"mods":["Alt"],"key":"Tab"}',
    ]);
  });
});

test('the phone page (default role) keeps controlling the local computer even with a receiver connected', async () => {
  await withServer(async (app) => {
    const receiver = await connectWs(app.port);
    await sendAndWait(receiver, { t: 'hello', pin: '1234', role: 'receiver' });

    const phone = await connectWs(app.port);
    await sendAndWait(phone, { t: 'hello', pin: '1234' });
    mock.reset();

    phone.send(JSON.stringify({ t: 'key', k: 'q' }));
    phone.send(JSON.stringify({ t: 'mouse', dx: 5, dy: 0 }));
    await new Promise((r) => setTimeout(r, 200));

    const kinds = mock.events.map((e) => e.kind + ':' + JSON.stringify(e.payload));
    assert.deepStrictEqual(kinds, ['tapChar:"q"', 'mouseMove:{"dx":5,"dy":0}']);
  });
});

test('a new receiver replaces the old one', async () => {
  await withServer(async (app) => {
    const first = await connectWs(app.port);
    await sendAndWait(first, { t: 'hello', pin: '1234', role: 'receiver' });

    let firstClosed = false;
    first.on('close', () => (firstClosed = true));

    const second = await connectWs(app.port);
    await sendAndWait(second, { t: 'hello', pin: '1234', role: 'receiver' });
    await new Promise((r) => setTimeout(r, 150));

    assert.strictEqual(firstClosed, true, 'old receiver should be closed');
    const status = await getJson(app.port, '/api/status');
    assert.strictEqual(status.body.receiver, true);
  });
});

test('serves the downloads page, API and per-OS bundles', async () => {
  await withServer(async (app) => {
    const page = await getText(app.port, '/download');
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /Wireless, on every device/);

    const dl = await getJson(app.port, '/api/downloads');
    assert.strictEqual(dl.status, 200);
    assert.strictEqual(dl.body.ok, true);
    assert.ok(dl.body.version);
    const ids = dl.body.platforms.map((p) => p.id);
    for (const id of ['windows', 'linux', 'macos', 'android-source']) {
      assert.ok(ids.includes(id), 'missing platform ' + id);
    }
    for (const p of dl.body.platforms) {
      assert.ok(p.filename.endsWith('.zip'), 'expected zip filename for ' + p.id);
      assert.ok(p.size > 0, 'expected non-empty bundle for ' + p.id);
    }
    assert.ok('apk' in dl.body);
    assert.ok('windowsPortable' in dl.body.installers, 'installers should expose windowsPortable');

    // Standalone installers (when built into dist/) take priority over the
    // on-the-fly source zips — assert whichever the route actually serves.
    const hasInstaller = (id) =>
      (id === 'windows' && dl.body.installers.windows) ||
      (id === 'linux' && dl.body.installers.linux) ||
      (id === 'macos' && (dl.body.installers.macos.arm64 || dl.body.installers.macos.x64));
    for (const id of ['windows', 'linux', 'macos']) {
      const res = await getBuffer(app.port, '/download/' + id);
      assert.strictEqual(res.status, 200);
      assert.match(res.headers['content-disposition'], /attachment/);
      if (hasInstaller(id)) {
        assert.strictEqual(res.headers['content-type'], 'application/octet-stream');
        if (id === 'windows') {
          assert.strictEqual(res.body[0], 0x4d, 'exe MZ magic byte 0');
          assert.strictEqual(res.body[1], 0x5a, 'exe MZ magic byte 1');
        }
      } else {
        assert.strictEqual(res.headers['content-type'], 'application/zip');
        // Real archive: PK magic at the start, EOCD signature at the end.
        assert.strictEqual(res.body[0], 0x50, id + ': zip PK magic byte 0');
        assert.strictEqual(res.body[1], 0x4b, id + ': zip PK magic byte 1');
        assert.strictEqual(res.body[res.body.length - 22], 0x50);
        assert.strictEqual(res.body[res.body.length - 21], 0x4b);
        assert.strictEqual(res.body[res.body.length - 20], 0x05);
        assert.strictEqual(res.body[res.body.length - 19], 0x06);
      }
    }

    const src = await getBuffer(app.port, '/download/android-source');
    assert.strictEqual(src.status, 200);
    assert.strictEqual(src.body[0], 0x50);
    assert.strictEqual(src.body[1], 0x4b);

    const nope = await getText(app.port, '/download/bogus');
    assert.strictEqual(nope.status, 404);

    // Every desktop OS exposes an installer slot (null until built) plus the
    // Linux archive/AppImage split and the auto-update feed.
    for (const key of ['windows', 'windowsPortable', 'linux', 'linuxArchive', 'linuxAppImage', 'updateFeed']) {
      assert.ok(key in dl.body.installers, 'installers should expose ' + key);
    }
    assert.ok('arm64' in dl.body.installers.macos && 'x64' in dl.body.installers.macos);

    // A served APK (when one is built) reports a real size and filename.
    if (dl.body.apk) {
      assert.ok(dl.body.apk.size > 0);
      assert.match(dl.body.apk.filename, /\.apk$/);
    }
  });
});

test('serves per-architecture macOS builds and the update feed path safely', async () => {
  await withServer(async (app) => {
    const dl = await getJson(app.port, '/api/downloads');
    for (const [route, meta] of [
      ['/download/macos-arm64', dl.body.installers.macos.arm64],
      ['/download/macos-x64', dl.body.installers.macos.x64],
    ]) {
      const res = await getBuffer(app.port, route);
      if (meta) {
        assert.strictEqual(res.status, 200, route + ' should serve the zip when built');
        assert.strictEqual(res.headers['content-type'], 'application/octet-stream');
        assert.strictEqual(res.body[0], 0x50);
        assert.strictEqual(res.body[1], 0x4b);
      } else {
        // No explicit zip -> falls back to the generic macos build or 404s.
        assert.ok([200, 404].includes(res.status));
      }
    }

    // Path traversal and unknown feed files are refused with 404, never a file.
    for (const bad of ['/downloads/..%2f..%2fserver.js', '/downloads/nope-1.2.3.exe']) {
      const res = await getText(app.port, bad);
      assert.strictEqual(res.status, 404, bad + ' must not resolve');
    }

    // The feed route serves latest.yml verbatim once a signed win build exists.
    const feed = await getText(app.port, '/downloads/latest.yml');
    if (dl.body.installers.updateFeed) {
      assert.strictEqual(feed.status, 200);
      assert.match(feed.body, /version:/);
    } else {
      assert.strictEqual(feed.status, 404);
    }
  });
});

test('enforces the client limit', async () => {
  await withServer(async (app) => {
    const a = await connectWs(app.port);
    const b = await connectWs(app.port);
    const c = await connectWs(app.port);
    // maxClients defaults to 3; a 4th connection must be refused.
    const refused = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
      ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
      ws.on('error', () => resolve(503));
    });
    assert.strictEqual(refused, 503);
    a.close();
    b.close();
    c.close();
  });
});