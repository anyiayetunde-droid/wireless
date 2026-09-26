'use strict';

/**
 * Linux driver.
 *
 * Uses xdotool (XTEST). Requires an X server; on Wayland install xdotool and
 * run under XWayland, or replace with ydotool.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeQueue } = require('../queue');
const { SPECIAL_KEYS, MODIFIERS } = require('../keymap');

const name = 'linux';
const queue = makeQueue();

let availability = null;

function xdotoolAvailable() {
  if (availability !== null) return availability;
  try {
    execFileSync('xdotool', ['version'], { stdio: 'ignore' });
    availability = true;
  } catch {
    availability = false;
  }
  return availability;
}

function xdo(args) {
  return queue(
    () =>
      new Promise((resolve) => {
        const p = spawn('xdotool', args, { stdio: 'ignore' });
        p.on('error', () => resolve(false));
        p.on('close', () => resolve(true));
      })
  );
}

function pipeTo(cmd, args, input) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => resolve(false));
    p.on('close', () => resolve(true));
    p.stdin.end(input);
  });
}

async function init() {
  if (!xdotoolAvailable()) {
    return {
      ok: false,
      hint: 'xdotool is not installed. Run: sudo apt install xdotool (or use ydotool on Wayland).',
    };
  }
  return { ok: true };
}

async function tapChar(char) {
  if (char === ' ') return xdo(['key', '--clearmodifiers', 'space']);
  return xdo(['type', '--clearmodifiers', '--delay', '1', char]);
}

async function tapKey(keyName) {
  const key = SPECIAL_KEYS[keyName];
  if (!key) return { ok: false, reason: 'unsupported key' };
  return xdo(['key', '--clearmodifiers', key.linux]);
}

async function tapCombo(mods, key) {
  const combo = mods.map((m) => MODIFIERS[m] && MODIFIERS[m].linux).filter(Boolean).join('+');
  const target = isSpecialKey(key) ? SPECIAL_KEYS[key].linux : key;
  return xdo(['key', '--clearmodifiers', combo ? `${combo}+${target}` : target]);
}

async function typeText(str) {
  if (!str) return { ok: true };
  if (/^[\x20-\x7E]*$/.test(str)) {
    for (const seg of str.split(/(\n|\t)/)) {
      if (seg === '\n') await xdo(['key', '--clearmodifiers', 'Return']);
      else if (seg === '\t') await xdo(['key', '--clearmodifiers', 'Tab']);
      else if (seg) await xdo(['type', '--clearmodifiers', '--delay', '1', seg]);
    }
    return { ok: true };
  }
  // Non-ASCII -> clipboard paste.
  const tmp = path.join(os.tmpdir(), `wireless-${process.pid}.txt`);
  fs.writeFileSync(tmp, str, 'utf8');
  const copied = await pipeTo('xclip', ['-selection', 'clipboard'], fs.readFileSync(tmp))
    || await pipeTo('xsel', ['-b'], fs.readFileSync(tmp));
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  if (!copied) return { ok: false, reason: 'xclip/xsel not available for unicode text' };
  await xdo(['key', '--clearmodifiers', 'ctrl+v']);
  return { ok: true };
}

async function mouseMove(dx, dy) {
  await xdo(['mousemove_relative', '--', String(Math.round(dx)), String(Math.round(dy))]);
  return { ok: true };
}

const BUTTONS = { left: '1', middle: '2', right: '3' };

async function mouseButton(btn, down) {
  const n = BUTTONS[btn];
  if (!n) return { ok: false, reason: 'unsupported button' };
  await xdo([down ? 'mousedown' : 'mouseup', n]);
  return { ok: true };
}

async function scroll(dy) {
  const n = Math.max(-10, Math.min(10, Math.round(dy)));
  const clicks = Math.abs(n);
  const dir = n > 0 ? '4' : '5';
  for (let i = 0; i < clicks; i++) await xdo(['click', dir]);
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
    ok: xdotoolAvailable(),
    hint: 'Requires xdotool and an X server (sudo apt install xdotool).',
  }),
};

function isSpecialKey(keyName) {
  return Object.prototype.hasOwnProperty.call(SPECIAL_KEYS, keyName);
}