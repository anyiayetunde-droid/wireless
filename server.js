'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { loadDriver } = require('./lib/drivers');
const { makeQueue } = require('./lib/queue');
const { SPECIAL_KEYS, MODIFIERS, isSpecialKey } = require('./lib/keymap');
const { listDownloads, buildPlatform, findApk, findInstallers, humanSize } = require('./lib/bundler');

const APP_VERSION = require('./package.json').version;

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_CLIENTS = 3;
const MAX_TEXT_LENGTH = 10000;

// In SEA/bundled builds (Wireless.exe) the public/ files are embedded here,
// because there is no real filesystem next to the executable. In dev (plain
// `node server.js`) this stays undefined and files are read from disk.
const WIRELESS_ASSETS = globalThis.WIRELESS_ASSETS;

// Resolve a URL pathname ('/app.js') to an asset: either an embedded buffer or
// a file on disk. Returns null when the asset does not exist.
function loadAsset(name) {
  if (WIRELESS_ASSETS && Object.prototype.hasOwnProperty.call(WIRELESS_ASSETS, name)) {
    const raw = WIRELESS_ASSETS[name];
    return { data: Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'base64'), ext: path.extname(name).toLowerCase() };
  }
  const file = path.join(PUBLIC_DIR, path.normalize(name));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
  return { file, ext: path.extname(file).toLowerCase() };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function networkIPv4s() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const addr of entries || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

/**
 * Start the Wireless server.
 * options: { port, pin, driver, maxClients }
 * Returns { server, wss, driver, port, pin, close }.
 */
async function startServer(options = {}) {
  const port = options.port != null ? options.port : Number(process.env.PORT) || 8030;
  const pin = options.pin != null ? String(options.pin) : process.env.PIN || String(crypto.randomInt(1000, 10000));
  const maxClients = options.maxClients || MAX_CLIENTS;

  const driver = loadDriver(options.driver);
  let driverWarning = null;
  try {
    const res = await driver.init();
    if (res && res.ok === false) driverWarning = res.hint || 'driver unavailable';
  } catch (e) {
    driverWarning = e && e.message ? e.message : String(e);
  }
  if (driverWarning) {
    console.warn(`\n⚠️  ${driver.name} driver not available: ${driverWarning}`);
    console.warn('   Falling back to MOCK mode — input will be logged, not typed.\n');
  }

  const keyQueue = makeQueue();
  const mouseQueue = makeQueue();

  const wss = new WebSocketServer({ noServer: true });

  // The "receiver" is the phone that accepts input from a laptop (the Android
  // app's IME / accessibility services). At most one receiver is active.
  let receiverWs = null;

  const status = () => ({
    ok: true,
    name: 'wireless',
    pin,
    port,
    urls: networkIPv4s(),
    clients: wss.clients.size,
    maxClients,
    receiver: !!(receiverWs && receiverWs.readyState === receiverWs.OPEN),
    driver: {
      name: driver.name,
      ok: !driverWarning,
      hint: driverWarning || (driver.info ? driver.info().hint : ''),
    },
  });

  const qrUrl = () => {
    const ips = networkIPv4s();
    const host = ips[0] || '127.0.0.1';
    return `http://${host}:${port}/?pin=${pin}`;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        pathname = url.pathname;
      }

      if (pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(status()));
        return;
      }
      if (pathname === '/api/downloads') {
        const apk = findApk();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(
          JSON.stringify({
            ok: true,
            version: APP_VERSION,
            pkged: !!(process.pkg || globalThis.WIRELESS_SEA),
            platforms: listDownloads(),
            installers: findInstallers(),
            apk: apk ? { filename: apk.filename, size: apk.size, human: humanSize(apk.size) } : null,
          })
        );
        return;
      }
      const dlMatch = pathname.match(/^\/download\/([a-z0-9-]+)$/);
      if (dlMatch) {
        const which = dlMatch[1];

        // A prebuilt APK is served as-is.
        if (which === 'apk') {
          const apk = findApk();
          if (!apk) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('No APK built yet — build the Android app first (see BUILD.md).');
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'application/vnd.android.package-archive',
            'Content-Disposition': `attachment; filename="${apk.filename}"`,
            'Content-Length': apk.size,
            'Cache-Control': 'no-store',
          });
          fs.createReadStream(apk.abs).pipe(res);
          return;
        }

        // Standalone installers take priority over the on-the-fly source zips.
        const inst = findInstallers();
        const pick = (a) => {
          if (a) {
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': `attachment; filename="${a.filename}"`,
              'Content-Length': a.size,
              'Cache-Control': 'no-store',
            });
            fs.createReadStream(a.abs).pipe(res);
            return true;
          }
          return false;
        };
        if (which === 'windows' && pick(inst.windows)) return;
        if (which === 'windows-portable' && pick(inst.windowsPortable)) return;
        if (which === 'linux' && pick(inst.linux)) return;
        if (which === 'linux-archive' && pick(inst.linuxArchive)) return;
        if (which === 'linux-appimage' && pick(inst.linuxAppImage)) return;
        if (which === 'macos') {
          // Prefer the visitor's own chip, guessed from the User-Agent; the
          // page also offers explicit arm64 / x64 buttons.
          const arch = /Intel|Mac OS X 10|x86_64/i.test(req.headers['user-agent'] || '') ? 'x64' : 'arm64';
          if (pick(inst.macos[arch])) return;
          if (pick(inst.macos.arm64)) return;
          if (pick(inst.macos.x64)) return;
        }
        if (which === 'macos-arm64' && pick(inst.macos.arm64)) return;
        if (which === 'macos-x64' && pick(inst.macos.x64)) return;

        const bundle = buildPlatform(which);
        if (!bundle) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Unknown platform');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${bundle.info.filename}"`,
          'Content-Length': bundle.data.length,
          'Cache-Control': 'no-store',
        });
        res.end(bundle.data);
        return;
      }
      // Auto-update feed. electron-builder writes latest*.yml next to the
      // installers in dist-electron/; this host can act as an update mirror so
      // a field install pulls updates from a known address instead of the
      // public internet (point the app at it with WIRELESS_UPDATE_URL).
      if (pathname.startsWith('/downloads/')) {
        const name = path.basename(pathname.slice('/downloads/'.length));
        if (!name || !/^[\w.-]+$/.test(name)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        const candidates = [
          path.join(__dirname, 'dist-electron', name),
          path.join(__dirname, 'dist', name),
        ];
        let file = null;
        for (const c of candidates) {
          try {
            if (fs.statSync(c).isFile()) {
              file = c;
              break;
            }
          } catch {
            /* try the next location */
          }
        }
        if (!file) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('No update artifact built yet');
          return;
        }
        const ext = path.extname(name).toLowerCase();
        const mime =
          ext === '.yml' || ext === '.yaml'
            ? 'text/yaml; charset=utf-8'
            : MIME[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': fs.statSync(file).size,
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(file).pipe(res);
        return;
      }
      if (pathname === '/qr.png') {
        const buf = await QRCode.toBuffer(qrUrl(), { width: 480, margin: 1 });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(buf);
        return;
      }
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (pathname === '/') pathname = '/index.html';
      if (pathname === '/host') pathname = '/host.html';
      if (pathname === '/laptop') pathname = '/laptop.html';
      if (pathname === '/desktop') pathname = '/desktop.html';
      if (pathname === '/download' || pathname === '/downloads') pathname = '/download.html';

      const asset = loadAsset(pathname);
      if (!asset) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[asset.ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      if (asset.data) res.end(asset.data);
      else fs.createReadStream(asset.file).pipe(res);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (wss.clients.size >= maxClients) {
      socket.write('HTTP/1.1 503 Too Many Connections\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    let authed = false;
    let denied = false;
    let attempts = 0;
    let role = 'phone'; // phone (controls this computer) | laptop (controls the phone) | receiver (the phone app)
    const eventTimes = [];

    const send = (obj) => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify(obj));
        } catch {
          /* ignore */
        }
      }
    };

    const helloTimer = setTimeout(() => {
      if (!authed) ws.close(4001, 'hello timeout');
    }, 10000);

    // Sends an event to the phone receiver (if a laptop is controlling it).
    const deliver = (evt) => {
      if (role === 'laptop' && receiverWs && receiverWs.readyState === receiverWs.OPEN) {
        try {
          receiverWs.send(JSON.stringify(evt));
          return true;
        } catch {
          /* fall through to the local driver */
        }
      }
      return false;
    };

    const cleanMods = (mods) =>
      Array.isArray(mods) ? mods.filter((m) => typeof m === 'string' && m in MODIFIERS).slice(0, 4) : [];

    // Shared "type a key" logic for both roles (falls back to the local driver).
    const tapKey = async (k) => {
      if (k === '\n') {
        await keyQueue(() => driver.tapKey('Enter'));
      } else if (isSpecialKey(k)) {
        await keyQueue(() => driver.tapKey(k));
      } else if (k.length === 1) {
        await keyQueue(() => driver.tapChar(k));
      }
    };

    const handle = async (msg) => {
      switch (msg.t) {
        case 'ping':
          send({ t: 'pong' });
          break;
        case 'key': {
          const k = msg.k;
          if (typeof k !== 'string' || k.length === 0) break;
          if (deliver(msg)) break;
          await tapKey(k);
          break;
        }
        case 'text': {
          if (typeof msg.s !== 'string') break;
          if (deliver(msg)) break;
          await keyQueue(() => driver.typeText(msg.s.slice(0, MAX_TEXT_LENGTH)));
          break;
        }
        case 'combo': {
          const mods = cleanMods(msg.mods);
          if (typeof msg.k !== 'string') break;
          if (deliver(msg)) break;
          await keyQueue(() => driver.tapCombo(mods, msg.k));
          break;
        }
        // Physical keyboard events (from the laptop page). Down/up pairs let the
        // phone hold keys and keep modifier state accurate.
        case 'keydown': {
          const k = msg.k;
          if (typeof k !== 'string' || k.length === 0) break;
          if (deliver(msg)) break;
          const mods = cleanMods(msg.mods);
          if (mods.length) await keyQueue(() => driver.tapCombo(mods, k));
          else await tapKey(k);
          break;
        }
        case 'keyup': {
          // No-op on the local driver (it is tap-based); forwarded to the phone.
          deliver(msg);
          break;
        }
        // System navigation on the phone (Android accessibility service).
        case 'nav': {
          const allowed = ['back', 'home', 'recents', 'notifications', 'quick_settings'];
          if (allowed.includes(msg.a)) deliver(msg);
          break;
        }
        // Touch gestures on the phone: normalized 0..1 coordinates.
        case 'phone': {
          const g = msg.g;
          const norm = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
          };
          if (g === 'tap') {
            const x = norm(msg.x);
            const y = norm(msg.y);
            if (x != null && y != null) deliver({ t: 'phone', g: 'tap', x, y });
          } else if (g === 'swipe') {
            const x0 = norm(msg.x0);
            const y0 = norm(msg.y0);
            const x1 = norm(msg.x1);
            const y1 = norm(msg.y1);
            if (x0 != null && y0 != null && x1 != null && y1 != null) {
              deliver({ t: 'phone', g: 'swipe', x0, y0, x1, y1 });
            }
          } else if (g === 'scroll') {
            const dy = Number(msg.dy);
            if (Number.isFinite(dy) && dy !== 0) deliver({ t: 'phone', g: 'scroll', dy });
          }
          break;
        }
        case 'mouse': {
          const dx = Math.round(Number(msg.dx) || 0);
          const dy = Math.round(Number(msg.dy) || 0);
          if (msg.btn) {
            const btn = String(msg.btn);
            await mouseQueue(() => driver.mouseButton(btn, !!msg.down));
          } else if (dx || dy) {
            await mouseQueue(() => driver.mouseMove(dx, dy));
          }
          break;
        }
        case 'scroll': {
          const dy = Number(msg.dy) || 0;
          if (dy) await mouseQueue(() => driver.scroll(dy));
          break;
        }
        default:
          send({ t: 'error', msg: 'unknown message type' });
      }
    };

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send({ t: 'error', msg: 'invalid JSON' });
        return;
      }
      if (!authed) {
        if (!msg || msg.t !== 'hello') return;
        attempts += 1;
        if (attempts > 5) {
          send({ t: 'welcome', ok: false, msg: 'Too many attempts' });
          ws.close(4000, 'too many attempts');
          return;
        }
        if (String(msg.pin) !== pin) {
          denied = true;
          send({ t: 'welcome', ok: false, msg: 'Wrong PIN — check the number on your computer screen' });
          return;
        }
        if (msg.role === 'laptop' || msg.role === 'receiver') role = msg.role;
        if (role === 'receiver') {
          // Only one phone receiver at a time; the newest one wins.
          if (receiverWs && receiverWs !== ws && receiverWs.readyState === receiverWs.OPEN) {
            receiverWs.close(4002, 'replaced by new receiver');
          }
          receiverWs = ws;
        }
        authed = true;
        clearTimeout(helloTimer);
        send({ t: 'welcome', ok: true, msg: 'Connected' });
        console.log(`${role === 'receiver' ? '📲 Phone receiver connected' : role === 'laptop' ? '💻 Laptop connected' : '📱 Phone connected'} (${req.socket.remoteAddress})`);
        return;
      }

      const now = Date.now();
      eventTimes.push(now);
      while (eventTimes.length && now - eventTimes[0] > 1000) eventTimes.shift();
      if (eventTimes.length > 400) {
        ws.close(4008, 'rate limit exceeded');
        return;
      }
      handle(msg).catch((e) => console.error('event error:', e && e.message ? e.message : e));
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (receiverWs === ws) receiverWs = null;
      console.log(`${role === 'receiver' ? '📲 Phone receiver disconnected' : role === 'laptop' ? '💻 Laptop disconnected' : '📱 Phone disconnected'}`);
    });

    ws.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));

  return {
    server,
    wss,
    driver,
    port: server.address().port,
    pin,
    qrUrl,
    status,
    close: () =>
      new Promise((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        // Close idle keep-alive connections that would otherwise block server.close().
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

async function main() {
  const app = await startServer();
  const port = app.port;
  const ips = networkIPv4s();
  const localUrl = `http://127.0.0.1:${port}`;
  const qr = await QRCode.toString(app.qrUrl(), { type: 'terminal', small: true });

  console.log('');
  console.log('┌────────────────────────────────────────────────┐');
  console.log('│  📶 Wireless                                       │');
  console.log('│                                               │');
  console.log('│  1. Put your phone on the same Wi-Fi network  │');
  console.log('│  2. Scan the QR code below with your camera   │');
  console.log('│     (or open the URL manually)                │');
  console.log('│  3. Keep the target window on your computer   │');
  console.log('│     focused and start typing                  │');
  console.log('└────────────────────────────────────────────────┘');
  console.log('');
  if (ips.length === 0) {
    console.log('  ⚠️  No LAN IP found — your phone must open the URL manually:');
    console.log(`  📱 http://<this-computer-ip>:${port}/`);
  } else {
    for (const ip of ips) {
      console.log(`  📱 Phone:  http://${ip}:${port}/`);
    }
  }
  console.log(`  🖥️  Host page (QR + status): ${localUrl}/host`);
  console.log(`  💻  Laptop page (type into your phone): ${localUrl}/laptop`);
  console.log(`  ⬇️  Downloads (apps for every OS): ${localUrl}/download`);
  console.log('');
  console.log(`  🔑 PIN: ${app.pin}`);
  console.log('');
  console.log(qr);
  console.log('');
  console.log('  Driver: ' + (app.driver.name === 'mock' ? 'MOCK (see warning above)' : app.driver.name));
  console.log('  Press Ctrl+C to stop.');
  console.log('');
}

if (require.main === module || globalThis.WIRELESS_SEA) {
  main().catch((e) => {
    console.error('Failed to start:', e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = { startServer, networkIPv4s, PUBLIC_DIR, loadAsset };