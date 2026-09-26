'use strict';

/**
 * Mock driver: records every call instead of injecting real input.
 * Useful for testing the phone UI without an OS, and for the test suite.
 */

const name = 'mock';
const events = [];

function record(kind, payload) {
  events.push({ kind, payload });
  console.log(`[mock] ${kind} ${JSON.stringify(payload)}`);
}

function init() {
  return Promise.resolve({ ok: true });
}

async function tapChar(char) {
  record('tapChar', char);
  return { ok: true };
}

async function tapKey(keyName) {
  record('tapKey', keyName);
  return { ok: true };
}

async function tapCombo(mods, key) {
  record('tapCombo', { mods, key });
  return { ok: true };
}

async function typeText(str) {
  record('typeText', str);
  return { ok: true };
}

async function mouseMove(dx, dy) {
  record('mouseMove', { dx, dy });
  return { ok: true };
}

async function mouseButton(btn, down) {
  record('mouseButton', { btn, down });
  return { ok: true };
}

async function scroll(dy) {
  record('scroll', dy);
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
  info: () => ({ name, ok: true, hint: 'Mock driver — logs events, does not type anything.' }),
  events,
  reset() {
    events.length = 0;
  },
};