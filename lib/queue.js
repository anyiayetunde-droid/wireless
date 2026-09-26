'use strict';

/**
 * Minimal serial async queue. Every driver funnels its calls through one of
 * these so that keystrokes are injected strictly in the order they arrive.
 */
function makeQueue() {
  let tail = Promise.resolve();
  function enqueue(fn) {
    const result = tail.then(fn);
    // Never let a failed task break the chain for later tasks.
    tail = result.then(
      () => {},
      () => {}
    );
    return result;
  }
  return enqueue;
}

module.exports = { makeQueue };