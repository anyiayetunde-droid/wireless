'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  SPECIAL_KEYS,
  MODIFIERS,
  winCharToken,
  chunkToSendKeys,
  escapePowerShell,
  escapeAppleScript,
  isSpecialKey,
  isModifier,
} = require('../lib/keymap');

test('winCharToken maps every printable US-layout character', () => {
  const printable = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    + ' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
  for (const c of printable) {
    assert.ok(winCharToken(c) != null, `no token for ${JSON.stringify(c)}`);
  }
  assert.strictEqual(winCharToken('é'), null);
  assert.strictEqual(winCharToken('\n'), null);
});

test('winCharToken shifted symbols need shift+base key', () => {
  assert.strictEqual(winCharToken('!'), '+1');
  assert.strictEqual(winCharToken('@'), '+2');
  assert.strictEqual(winCharToken('A'), '+a');
  assert.strictEqual(winCharToken('_'), '+-');
  assert.strictEqual(winCharToken('{'), '+{{}');
  assert.strictEqual(winCharToken('}'), '+{}}');
  assert.strictEqual(winCharToken('|'), '+\\');
  assert.strictEqual(winCharToken('~'), '+`');
  assert.strictEqual(winCharToken('"'), '+"');
  assert.strictEqual(winCharToken('?'), '+/');
  assert.strictEqual(winCharToken('-'), '-');
  assert.strictEqual(winCharToken('['), '[');
});

test('chunkToSendKeys escapes text and control characters', () => {
  assert.strictEqual(chunkToSendKeys('hello world'), 'hello world');
  assert.strictEqual(chunkToSendKeys('a!b'), 'a+1b');
  assert.strictEqual(chunkToSendKeys('{x}'), '+{{}x+{}}');
  assert.strictEqual(chunkToSendKeys('line1\nline2'), 'line1{ENTER}line2');
  assert.strictEqual(chunkToSendKeys('a\tb'), 'a{TAB}b');
});

test('escapePowerShell handles quotes, backticks and dollar signs', () => {
  assert.strictEqual(escapePowerShell('+"'), '+`"');
  assert.strictEqual(escapePowerShell('$HOME'), '`$HOME');
  assert.strictEqual(escapePowerShell('a`b'), 'a``b');
  assert.strictEqual(escapePowerShell('plain'), 'plain');
});

test('escapeAppleScript handles backslashes and quotes', () => {
  assert.strictEqual(escapeAppleScript('say "hi"'), 'say \\"hi\\"');
  assert.strictEqual(escapeAppleScript('a\\b'), 'a\\\\b');
});

test('every canonical special key is defined for all platforms', () => {
  for (const [name, key] of Object.entries(SPECIAL_KEYS)) {
    assert.ok(key.win != null, `no win mapping for ${name}`);
    assert.ok(key.linux != null, `no linux mapping for ${name}`);
    assert.ok(isSpecialKey(name));
  }
});

test('modifiers map everywhere', () => {
  for (const [name, mod] of Object.entries(MODIFIERS)) {
    assert.ok(mod.win != null && mod.mac != null && mod.linux != null, `incomplete ${name}`);
    assert.ok(isModifier(name));
  }
});

test('F-keys: F1..F12 use SendKeys braces, mac key codes 122..133', () => {
  assert.strictEqual(SPECIAL_KEYS.F1.win, '{F1}');
  assert.strictEqual(SPECIAL_KEYS.F12.win, '{F12}');
  assert.strictEqual(SPECIAL_KEYS.F1.mac, 122);
  assert.strictEqual(SPECIAL_KEYS.F12.mac, 133);
  assert.strictEqual(SPECIAL_KEYS.F5.linux, 'F5');
});