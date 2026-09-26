'use strict';

const mock = require('./mock');

/**
 * Pick the input driver.
 * KEYBOARD_DRIVER=mock|windows|darwin|linux|auto overrides auto-detection.
 */
function loadDriver(forced) {
  const want = (forced || process.env.KEYBOARD_DRIVER || 'auto').toLowerCase();
  switch (want) {
    case 'mock':
      return mock;
    case 'windows':
      return require('./windows');
    case 'darwin':
    case 'macos':
      return require('./macos');
    case 'linux':
      return require('./linux');
    case 'auto':
    default:
      if (process.platform === 'win32') return require('./windows');
      if (process.platform === 'darwin') return require('./macos');
      if (process.platform === 'linux') return require('./linux');
      return mock;
  }
}

module.exports = { loadDriver };