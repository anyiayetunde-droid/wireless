'use strict';

/**
 * Canonical keyboard model shared by the server, the drivers and the protocol.
 *
 * The phone UI always sends either:
 *   - a single character (e.g. "a", "A", "!", "é")  ->  tapChar
 *   - a canonical special-key name (e.g. "Enter")   ->  tapKey
 *   - a shortcut combo (e.g. Control+C)             ->  tapCombo
 *
 * Each OS driver is responsible for translating those into real input.
 * The character table below follows the US keyboard layout.
 */

// Canonical special keys.
// win   = SendKeys token (Windows PowerShell)
// mac   = AppleScript key code (null = not available on macOS)
// linux = xdotool keysym
const SPECIAL_KEYS = {
  Enter: { win: '{ENTER}', mac: 36, linux: 'Return' },
  Backspace: { win: '{BACKSPACE}', mac: 51, linux: 'BackSpace' },
  Tab: { win: '{TAB}', mac: 48, linux: 'Tab' },
  Escape: { win: '{ESC}', mac: 53, linux: 'Escape' },
  Delete: { win: '{DELETE}', mac: 117, linux: 'Delete' },
  Insert: { win: '{INSERT}', mac: null, linux: 'Insert' },
  Home: { win: '{HOME}', mac: 115, linux: 'Home' },
  End: { win: '{END}', mac: 119, linux: 'End' },
  PageUp: { win: '{PGUP}', mac: 116, linux: 'Prior' },
  PageDown: { win: '{PGDN}', mac: 121, linux: 'Next' },
  ArrowUp: { win: '{UP}', mac: 126, linux: 'Up' },
  ArrowDown: { win: '{DOWN}', mac: 125, linux: 'Down' },
  ArrowLeft: { win: '{LEFT}', mac: 123, linux: 'Left' },
  ArrowRight: { win: '{RIGHT}', mac: 124, linux: 'Right' },
  Space: { win: ' ', mac: 49, linux: 'space' },
  CapsLock: { win: '{CAPSLOCK}', mac: 57, linux: 'Caps_Lock' },
  Super: { win: '{LWIN}', mac: 55, linux: 'Super_L' },
};

for (let i = 1; i <= 12; i++) {
  SPECIAL_KEYS['F' + i] = { win: `{F${i}}`, mac: 121 + i, linux: `F${i}` };
}

// Modifiers usable in shortcut combos.
const MODIFIERS = {
  Shift: { win: '+', mac: 'shift', linux: 'shift' },
  Control: { win: '^', mac: 'control', linux: 'ctrl' },
  Alt: { win: '%', mac: 'option', linux: 'alt' },
  Super: { win: '{LWIN}', mac: 'command', linux: 'super' },
};

/**
 * Windows SendKeys token for a single character (US layout).
 * Returns null when the character cannot be typed with SendKeys.
 */
function winCharToken(char) {
  if (char >= 'a' && char <= 'z') return char;
  if (char >= 'A' && char <= 'Z') return '+' + char.toLowerCase();
  if (char >= '0' && char <= '9') return char;
  switch (char) {
    case ' ': return ' ';
    case '!': return '+1';
    case '@': return '+2';
    case '#': return '+3';
    case '$': return '+4';
    case '%': return '+5';
    case '^': return '+6';
    case '&': return '+7';
    case '*': return '+8';
    case '(': return '+9';
    case ')': return '+0';
    case '-': return '-';
    case '_': return '+-';
    case '=': return '=';
    case '+': return '+=';
    case '[': return '[';
    case ']': return ']';
    case '{': return '+{{}';
    case '}': return '+{}}';
    case '\\': return '\\';
    case '|': return '+\\';
    case ';': return ';';
    case ':': return '+;';
    case "'": return "'";
    case '"': return '+"';
    case '`': return '`';
    case '~': return '+`';
    case ',': return ',';
    case '<': return '+,';
    case '.': return '.';
    case '>': return '+.';
    case '/': return '/';
    case '?': return '+/';
    default: return null;
  }
}

/**
 * Turn a run of characters into a SendKeys-safe string.
 * Control characters become their key tokens.
 */
function chunkToSendKeys(str) {
  let out = '';
  for (const c of str) {
    if (c === '\n') out += '{ENTER}';
    else if (c === '\r') { /* skip */ }
    else if (c === '\t') out += '{TAB}';
    else if (c === '\b') out += '{BACKSPACE}';
    else out += winCharToken(c) ?? '';
  }
  return out;
}

/** Escape a string for use inside a PowerShell double-quoted string. */
function escapePowerShell(s) {
  return s.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$');
}

/** Escape a string for use inside an AppleScript double-quoted string. */
function escapeAppleScript(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isSpecialKey(name) {
  return Object.prototype.hasOwnProperty.call(SPECIAL_KEYS, name);
}

function isModifier(name) {
  return Object.prototype.hasOwnProperty.call(MODIFIERS, name);
}

/** True when the string only contains printable ASCII. */
function isPrintableAscii(str) {
  return /^[\x20-\x7E]*$/.test(str);
}

module.exports = {
  SPECIAL_KEYS,
  MODIFIERS,
  winCharToken,
  chunkToSendKeys,
  escapePowerShell,
  escapeAppleScript,
  isSpecialKey,
  isModifier,
  isPrintableAscii,
};