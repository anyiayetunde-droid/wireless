'use strict';

/**
 * Windows driver.
 *
 * Uses one long-lived powershell.exe process that reads commands from stdin.
 * Keystrokes go through System.Windows.Forms.SendKeys, mouse events through
 * user32 mouse_event. No native npm dependencies required.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeQueue } = require('../queue');
const {
  SPECIAL_KEYS,
  MODIFIERS,
  winCharToken,
  chunkToSendKeys,
  escapePowerShell,
  isPrintableAscii,
} = require('../keymap');

const name = 'windows';
const queue = makeQueue();

let ps = null;
let booted = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startPS() {
  return new Promise((resolve, reject) => {
    try {
      ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(e);
      return;
    }
    ps.stderr.setEncoding('utf8');
    ps.stderr.on('data', (d) => {
      const text = String(d).trim();
      if (text) console.error('[powershell]', text);
    });
    ps.on('error', (e) => {
      ps = null;
      reject(e);
    });
    ps.on('exit', () => {
      ps = null;
      booted = false;
    });
    setTimeout(() => {
      if (ps && ps.exitCode === null) resolve();
      else reject(new Error('PowerShell did not start'));
    }, 400);
  });
}

async function ensure() {
  if (!ps || ps.exitCode !== null) {
    await startPS();
    booted = false;
  }
  if (!booted) {
    ps.stdin.write(
      [
        'Add-Type -AssemblyName System.Windows.Forms',
        `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class M{[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e);}'`,
      ].join('\r\n') + '\r\n'
    );
    booted = true;
    await sleep(120);
  }
}

/** Run one or more PowerShell statements through the persistent process. */
function run(lines) {
  return queue(async () => {
    await ensure();
    if (!ps || ps.exitCode !== null) return;
    const script = (Array.isArray(lines) ? lines : [lines]).join('\r\n');
    ps.stdin.write(script + '\r\n');
    // Give the shell time to execute before the next statement.
    await sleep(16);
  });
}

function init() {
  return run([]).then(() => ({ ok: true }));
}

function sendWait(token) {
  return run(`[System.Windows.Forms.SendKeys]::SendWait("${escapePowerShell(token)}")`);
}

async function tapChar(char) {
  const token = winCharToken(char);
  if (token == null) return { ok: false, reason: 'unmappable' };
  await sendWait(token);
  return { ok: true };
}

async function tapKey(keyName) {
  const key = SPECIAL_KEYS[keyName];
  if (!key || key.win == null) return { ok: false, reason: 'unsupported key' };
  await sendWait(key.win);
  return { ok: true };
}

async function tapCombo(mods, key) {
  const prefix = mods.map((m) => MODIFIERS[m] && MODIFIERS[m].win).filter(Boolean).join('');
  if (isSpecialKey(key)) {
    await sendWait(prefix + SPECIAL_KEYS[key].win);
  } else if (key.length === 1) {
    const token = winCharToken(key);
    if (token == null) return { ok: false, reason: 'unmappable' };
    await sendWait(prefix + token);
  } else {
    return { ok: false, reason: 'unsupported key' };
  }
  return { ok: true };
}

async function typeText(str) {
  if (!str) return { ok: true };
  if (isPrintableAscii(str)) {
    const lines = [];
    for (let i = 0; i < str.length; i += 60) {
      lines.push(
        `[System.Windows.Forms.SendKeys]::SendWait("${escapePowerShell(chunkToSendKeys(str.slice(i, i + 60)))}")`
      );
    }
    await run(lines);
    return { ok: true };
  }
  // Non-ASCII (or control chars) -> clipboard paste handles unicode reliably.
  return pasteText(str);
}

async function pasteText(str) {
  const tmp = path.join(os.tmpdir(), `wireless-${process.pid}.txt`);
  fs.writeFileSync(tmp, str, 'utf8');
  try {
    await run(`Get-Content -Raw -Encoding UTF8 -LiteralPath '${tmp}' | Set-Clipboard`);
    await sendWait('^v');
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  return { ok: true };
}

// user32 mouse_event flags.
const BUTTONS = {
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
};

async function mouseMove(dx, dy) {
  await run(`[M]::mouse_event(0x0001, ${Math.round(dx)}, ${Math.round(dy)}, 0, [IntPtr]::Zero)`);
  return { ok: true };
}

async function mouseButton(btn, down) {
  const flags = BUTTONS[btn];
  if (!flags) return { ok: false, reason: 'unsupported button' };
  await run(`[M]::mouse_event(${flags[down ? 'down' : 'up']}, 0, 0, 0, [IntPtr]::Zero)`);
  return { ok: true };
}

async function scroll(dy) {
  const n = Math.max(-10, Math.min(10, Math.round(dy)));
  if (n === 0) return { ok: true };
  await run(`[M]::mouse_event(0x0800, 0, 0, [uint32](0x100000000 + ${120 * n}), [IntPtr]::Zero)`);
  return { ok: true };
}

module.exports = {
  name,
  init,
  tapChar,
  tapKey,
  tapCombo,
  typeText,
  mouseMove,
  mouseButton,
  scroll,
  info: () => ({
    name,
    ok: true,
    hint: 'Injects keys into the foreground window; keep the target app focused. '
      + 'Does not work into elevated (admin) apps.',
  }),
};

function isSpecialKey(keyName) {
  return Object.prototype.hasOwnProperty.call(SPECIAL_KEYS, keyName);
}