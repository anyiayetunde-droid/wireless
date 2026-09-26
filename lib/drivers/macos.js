'use strict';

/**
 * macOS driver.
 *
 * Keystrokes are injected with AppleScript System Events (osascript), which is
 * built into every macOS. Mouse control uses cliclick when available.
 * Requires Accessibility permission for the calling terminal app.
 */

const { spawn } = require('child_process');
const { makeQueue } = require('../queue');
const {
  SPECIAL_KEYS,
  MODIFIERS,
  escapeAppleScript,
  isPrintableAscii,
} = require('../keymap');

const name = 'macos';
const queue = makeQueue();

function osa(script) {
  return new Promise((resolve, reject) => {
    const p = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', (d) => {
      err += d;
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `osascript exited with code ${code}`));
    });
  });
}

function cliclick(args) {
  return new Promise((resolve) => {
    const p = spawn('cliclick', args, { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', () => resolve(true));
  });
}

function isSimpleChar(c) {
  const code = c.codePointAt(0);
  return code >= 32 && code <= 126;
}

async function tapChar(char) {
  if (!isSimpleChar(char)) return { ok: false, reason: 'unmappable' };
  await queue(() => osa(`tell application "System Events" to keystroke "${escapeAppleScript(char)}"`));
  return { ok: true };
}

async function tapKey(keyName) {
  const key = SPECIAL_KEYS[keyName];
  if (!key || key.mac == null) return { ok: false, reason: 'unsupported key' };
  await queue(() => osa(`tell application "System Events" to key code ${key.mac}`));
  return { ok: true };
}

async function tapCombo(mods, key) {
  const using = mods.map((m) => MODIFIERS[m] && MODIFIERS[m].mac).filter(Boolean);
  if (using.length === 0) return tapKey(key);
  if (key.length === 1 && isSimpleChar(key)) {
    await queue(() =>
      osa(`tell application "System Events" to keystroke "${escapeAppleScript(key)}" using {${using.join(', ')}}`)
    );
    return { ok: true };
  }
  // System Events cannot combine modifiers with key codes reliably.
  return tapKey(key);
}

function buildTypeScript(str) {
  const parts = [];
  for (const seg of str.split(/(\n|\t)/)) {
    if (seg === '\n') parts.push('key code 36');
    else if (seg === '\t') parts.push('key code 48');
    else if (seg) parts.push(`keystroke "${escapeAppleScript(seg)}"`);
  }
  return parts.join('\n');
}

async function typeText(str) {
  if (!str) return { ok: true };
  if (isPrintableAscii(str)) {
    await queue(() => osa(`tell application "System Events"\n${buildTypeScript(str)}\nend tell`));
    return { ok: true };
  }
  // Non-ASCII -> clipboard paste via pbcopy (handles unicode perfectly).
  await queue(
    () =>
      new Promise((resolve, reject) => {
        const p = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'pipe'] });
        p.on('error', reject);
        p.on('close', () => resolve());
        p.stdin.end(str);
      })
  );
  await queue(() => osa(`tell application "System Events" to keystroke "v" using {command down}`));
  return { ok: true };
}

async function mouseMove(dx, dy) {
  const x = Math.round(dx);
  const y = Math.round(dy);
  await cliclick([`m:+${x},${y >= 0 ? '+' : ''}${y}`]);
  return { ok: true };
}

async function mouseButton(btn, down) {
  if (btn === 'left') {
    await cliclick([down ? 'dd:.' : 'du:.']);
  } else if (btn === 'right') {
    // cliclick has no right-button down/up; click on press.
    if (down) await cliclick(['rc:.']);
  }
  return { ok: true };
}

async function scroll(dy) {
  await cliclick([`w:${Math.round(dy)}`]);
  return { ok: true };
}

function init() {
  return Promise.resolve({ ok: true });
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
    hint: 'Needs Accessibility permission for the terminal (System Settings > Privacy & Security). '
      + 'Mouse control needs cliclick (brew install cliclick).',
  }),
};