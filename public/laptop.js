(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const params = new URLSearchParams(location.search);
  const urlPin = params.get('pin') || '';

  // ---------- state ----------
  let ws = null;
  let authed = false;
  let denied = false;
  let reconnectTimer = null;
  let pin = urlPin;
  let mode = 'keys'; // keys | text | touch
  let layer = 'main'; // main | sym | func
  let shift = false;
  let caps = false;
  let lastShiftTap = 0;
  let receiverOnline = false;

  // ---------- on-screen keyboard layouts (same as the phone page) ----------
  const LAYOUTS = {
    main: [
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', { k: 'Backspace' }],
      ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
      ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', { k: 'Enter' }],
      [{ k: 'Shift' }, 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', { k: 'Shift' }],
      [{ k: '?123' }, { k: 'Space', wide: true }, { k: 'Enter' }],
    ],
    sym: [
      ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')', { k: 'Backspace' }],
      ['`', '~', '-', '_', '=', '+', '[', ']', '{', '}'],
      ['\\', '|', ';', ':', "'", '"', ',', '<', '.', '>', '/'],
      [{ k: 'ABC' }, { k: 'Space', wide: true }, { k: 'Enter' }],
    ],
    func: [
      [
        { k: 'Escape' }, { k: 'F1' }, { k: 'F2' }, { k: 'F3' }, { k: 'F4' },
        { k: 'F5' }, { k: 'F6' }, { k: 'F7' }, { k: 'F8' }, { k: 'F9' },
        { k: 'F10' }, { k: 'F11' }, { k: 'F12' },
      ],
      [
        { combo: ['Control', 'c'], label: 'Ctrl+C' },
        { combo: ['Control', 'v'], label: 'Ctrl+V' },
        { combo: ['Control', 'x'], label: 'Ctrl+X' },
        { combo: ['Control', 'a'], label: 'Ctrl+A' },
        { combo: ['Control', 'z'], label: 'Ctrl+Z' },
        { combo: ['Control', 'y'], label: 'Ctrl+Y' },
        { combo: ['Alt', 'Tab'], label: 'Alt+Tab' },
        { k: 'Super', label: '⊞' },
        { k: 'Delete', label: 'Del' },
      ],
      [
        { k: 'Home' }, { k: 'End' }, { k: 'PageUp' }, { k: 'PageDown' },
        { k: 'Caps' }, { k: 'Insert' }, { k: 'Tab' }, { k: 'Escape' },
      ],
      [{ k: 'ABC' }, { k: 'Space', wide: true }, { k: 'Enter' }],
    ],
  };

  const ARROW_ROW = [
    { k: 'ArrowLeft' }, { k: 'ArrowUp' }, { k: 'ArrowDown' }, { k: 'ArrowRight' },
    { k: 'Escape' }, { k: 'Tab' },
  ];

  const LABELS = {
    Backspace: '⌫',
    Enter: '⏎',
    Space: 'Space',
    Shift: '⇧',
    Caps: '⇪',
    Escape: 'Esc',
    '?123': '?123',
    ABC: 'ABC',
    ArrowLeft: '←',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowRight: '→',
    Home: '⇱',
    End: '⇲',
    PageUp: '⇞',
    PageDown: '⇟',
    Insert: 'Ins',
    Delete: 'Del',
    Tab: '⇥',
    Super: '⊞',
  };
  for (let i = 1; i <= 12; i++) LABELS['F' + i] = 'F' + i;

  // ---------- websocket ----------
  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    }
  }

  function connect() {
    clearTimeout(reconnectTimer);
    setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      send({ t: 'hello', pin, role: 'laptop' });
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        if (msg.ok) {
          authed = true;
          denied = false;
          setStatus('connected');
          $('#connectScreen').classList.add('hidden');
          $('#app').classList.remove('hidden');
        } else {
          denied = true;
          authed = false;
          setStatus('error');
          showConnectError(msg.msg || 'Connection failed');
        }
      }
    };
    ws.onclose = () => {
      const wasAuthed = authed;
      authed = false;
      setStatus('disconnected');
      if (denied) {
        showConnectError('Wrong PIN — check the number on your computer screen.');
        return;
      }
      if (wasAuthed) {
        $('#connectScreen').classList.remove('hidden');
        $('#app').classList.add('hidden');
        showConnectError('Connection lost — reconnecting…');
      }
      scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    if (denied) return;
    reconnectTimer = setTimeout(connect, 2000);
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    denied = true;
    try {
      if (ws) ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
    authed = false;
    setStatus('disconnected');
    $('#app').classList.add('hidden');
    $('#connectScreen').classList.remove('hidden');
  }

  // ---------- status UI ----------
  function setStatus(state) {
    const dot = $('#statusDot');
    dot.className = 'dot ' + state;
  }

  function showConnectError(text) {
    const el = $('#connectStatus');
    el.textContent = text || '';
    el.classList.remove('ok');
  }

  async function pollStatus() {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      const s = await res.json();
      receiverOnline = !!s.receiver;
      const dot = $('#phoneDot');
      dot.classList.toggle('connected', receiverOnline);
      dot.classList.toggle('error', !receiverOnline);
      $('#routeLabel').textContent = receiverOnline
        ? 'your phone (app connected)'
        : 'this computer (no phone app connected)';
    } catch {
      /* host unreachable — keep last state */
    }
  }

  // ---------- on-screen keyboard ----------
  function charLabel(ch) {
    if (/^[a-z]$/.test(ch) && (shift || caps)) return ch.toUpperCase();
    return ch;
  }

  function defLabel(def) {
    if (typeof def === 'string') return charLabel(def);
    if (def.label) return def.label;
    return LABELS[def.k] || def.k || '?';
  }

  function renderKeyboard() {
    const rows = LAYOUTS[layer].map((row) => row.slice());
    rows.push(ARROW_ROW);
    const container = $('#keyboard');
    let html = '';
    let idx = 0;
    const defs = [];
    for (const row of rows) {
      html += '<div class="kb-row">';
      for (const def of row) {
        const cls = ['key'];
        const isChar = typeof def === 'string';
        const k = isChar ? null : def.k;
        if (!isChar && (k === 'Shift' || k === 'Caps')) cls.push(shift || caps ? 'shifted' : 'alt');
        if (!isChar && k === 'Caps' && caps) cls.push('caps-on');
        if (!isChar && k === 'Escape') cls.push('alt');
        if (!isChar && (def.label || (k && /^F\d+$/.test(k)))) cls.push('fn');
        if (!isChar && def.wide) cls.push('wide');
        if (!isChar && k === 'Space') cls.push('wider');
        if (isChar && !/^[a-zA-Z0-9]$/.test(def)) cls.push('alt');
        if (!isChar && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) cls.push('arrow-row');
        defs.push(def);
        html += `<div class="${cls.join(' ')}" data-i="${idx}">${defLabel(def)}</div>`;
        idx += 1;
      }
      html += '</div>';
    }
    container.innerHTML = html;
    container._defs = defs;
  }

  function toggleShift() {
    const now = Date.now();
    if (shift && now - lastShiftTap < 300) {
      shift = false;
      caps = !caps;
    } else {
      shift = !shift;
    }
    lastShiftTap = now;
    renderKeyboard();
  }

  function onKeyDown(def) {
    if (typeof def === 'string') {
      let ch = def;
      if (/^[a-z]$/.test(ch) && (shift || caps)) ch = ch.toUpperCase();
      send({ t: 'key', k: ch });
      if (/^[a-zA-Z]$/.test(ch)) {
        shift = false;
        renderKeyboard();
      }
      return;
    }
    if (def.combo) {
      send({ t: 'combo', mods: def.combo.slice(0, -1), k: def.combo[def.combo.length - 1] });
      return;
    }
    switch (def.k) {
      case 'Shift':
        toggleShift();
        return;
      case 'Caps':
        caps = !caps;
        renderKeyboard();
        return;
      case '?123':
        layer = 'sym';
        renderKeyboard();
        return;
      case 'ABC':
        layer = 'main';
        renderKeyboard();
        return;
      default:
        break;
    }
    send({ t: 'key', k: def.k });
  }

  function bindKeyboard() {
    const kb = $('#keyboard');
    const defAt = (el) => {
      const i = el && el.dataset ? Number(el.dataset.i) : -1;
      return kb._defs && Number.isInteger(i) && kb._defs[i] !== undefined ? kb._defs[i] : null;
    };
    kb.addEventListener('mousedown', (e) => {
      const def = defAt(e.target.closest('.key'));
      if (def) onKeyDown(def);
    });
  }

  // ---------- physical keyboard capture ----------
  const CODE_SPECIAL = {
    Enter: 'Enter',
    NumpadEnter: 'Enter',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Escape: 'Escape',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    Space: 'Space',
    CapsLock: 'CapsLock',
    F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
    F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
  };

  // code -> canonical key for keys where e.key is unreliable
  const CODE_KEYS = {};
  for (let i = 1; i <= 9; i++) CODE_KEYS['Digit' + i] = String(i);
  CODE_KEYS.Digit0 = '0';
  CODE_KEYS.Minus = '-';
  CODE_KEYS.Equal = '=';
  CODE_KEYS.BracketLeft = '[';
  CODE_KEYS.BracketRight = ']';
  CODE_KEYS.Backslash = '\\';
  CODE_KEYS.Semicolon = ';';
  CODE_KEYS.Quote = "'";
  CODE_KEYS.Comma = ',';
  CODE_KEYS.Period = '.';
  CODE_KEYS.Slash = '/';
  CODE_KEYS.Backquote = '`';
  CODE_KEYS.IntlBackslash = '\\';
  for (let i = 0; i < 26; i++) CODE_KEYS['Key' + String.fromCharCode(65 + i)] = String.fromCharCode(97 + i);

  function keyOf(e) {
    // e.key is layout-aware: it already carries the Shift case for letters and
    // symbols. Fall back to the code table for keys where e.key is "Unidentified".
    if (e.key && e.key.length === 1) return e.key;
    return CODE_KEYS[e.code] || CODE_SPECIAL[e.code] || null;
  }

  function modsOf(e) {
    const mods = [];
    if (e.shiftKey) mods.push('Shift');
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.metaKey) mods.push('Super');
    return mods;
  }

  function inOwnTextField() {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  }

  function onPhysicalKeyDown(e) {
    if (inOwnTextField()) return; // let the page's own inputs work normally
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'ControlLeft' || e.code === 'ControlRight' ||
        e.code === 'AltLeft' || e.code === 'AltRight' || e.code === 'MetaLeft' || e.code === 'MetaRight') {
      return; // modifiers alone do nothing; they are included in key messages
    }
    const mods = modsOf(e);
    const k = keyOf(e);
    if (!k) return;
    const chord = mods.some((m) => m === 'Control' || m === 'Alt' || m === 'Super');
    e.preventDefault();
    if (chord) {
      // Shortcut combos (Ctrl+C etc.) go as a single combo message.
      send({ t: 'combo', mods, k });
      return;
    }
    send({ t: 'keydown', k, mods });
  }

  function onPhysicalKeyUp(e) {
    if (inOwnTextField()) return;
    const mods = modsOf(e);
    const k = keyOf(e);
    if (!k) return;
    send({ t: 'keyup', k, mods });
  }

  // ---------- touch pad (mini phone screen) ----------
  const pad = $('#phonePad');
  const pointers = new Map();
  let padMoved = false;
  let scrollActive = false;
  let padStart = null;

  function padPos(e) {
    const r = pad.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }

  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    const p = padPos(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      padMoved = false;
      scrollActive = false;
      padStart = p;
    }
  });

  pad.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const cur = padPos(e);
    const dx = cur.x - p.x;
    const dy = cur.y - p.y;
    pointers.set(e.pointerId, cur);
    if (Math.abs(dx) + Math.abs(dy) < 0.004) return;
    if (pointers.size === 1) {
      if (!padMoved && Math.hypot(dx, dy) > 0.02) padMoved = true;
    } else if (pointers.size === 2) {
      scrollActive = true;
      if (dy) send({ t: 'phone', g: 'scroll', dy: Math.round(dy * 1200) });
    }
  });

  pad.addEventListener('pointerup', (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size !== 0) return;
    if (scrollActive) {
      scrollActive = false;
      return;
    }
    if (padMoved && padStart) {
      const end = padPos(e);
      send({ t: 'phone', g: 'swipe', x0: padStart.x, y0: padStart.y, x1: end.x, y1: end.y });
      padStart = null;
      return;
    }
    const p = padPos(e);
    send({ t: 'phone', g: 'tap', x: p.x, y: p.y });
  });

  pad.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    scrollActive = false;
  });

  // ---------- text mode ----------
  function bindTextMode() {
    $('#typeTextBtn').addEventListener('click', () => {
      const text = $('#textInput').value;
      const status = $('#textStatus');
      if (!text) {
        status.textContent = 'Nothing to type.';
        status.className = 'text-status err';
        return;
      }
      send({ t: 'text', s: text });
      status.textContent = `Sending ${text.length} characters…`;
      status.className = 'text-status';
      setTimeout(() => {
        status.textContent = `✓ Sent ${text.length} characters to the focused field on your phone.`;
      }, 300);
    });
    $('#clearTextBtn').addEventListener('click', () => {
      $('#textInput').value = '';
      $('#textStatus').textContent = '';
    });
  }

  // ---------- nav actions ----------
  function bindNav() {
    $('#navBtn').addEventListener('click', () => {
      const menu = $('#navMenu');
      menu.classList.toggle('hidden');
    });
    document.querySelectorAll('[data-nav]').forEach((b) => {
      b.addEventListener('click', () => {
        send({ t: 'nav', a: b.dataset.nav });
      });
    });
  }

  // ---------- mode switching ----------
  function setMode(m) {
    mode = m;
    document.querySelectorAll('.mode-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === m);
    });
    $('#keyboardMode').classList.toggle('hidden', m !== 'keys');
    $('#textMode').classList.toggle('hidden', m !== 'text');
    $('#touchMode').classList.toggle('hidden', m !== 'touch');
  }

  // ---------- wire up ----------
  function init() {
    bindKeyboard();
    bindTextMode();
    bindNav();

    document.querySelectorAll('.mode-btn').forEach((b) => {
      b.addEventListener('click', () => setMode(b.dataset.mode));
    });

    $('#disconnectBtn').addEventListener('click', disconnect);

    $('#connectBtn').addEventListener('click', () => {
      const entered = $('#pinInput').value.trim();
      if (!entered) {
        showConnectError('Enter the PIN first.');
        return;
      }
      pin = entered;
      denied = false;
      showConnectError('');
      connect();
    });
    $('#pinInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#connectBtn').click();
    });

    window.addEventListener('keydown', onPhysicalKeyDown);
    window.addEventListener('keyup', onPhysicalKeyUp);

    renderKeyboard();
    setMode('keys');
    setStatus('disconnected');
    pollStatus();
    setInterval(pollStatus, 2000);

    if (urlPin) {
      $('#connectScreen').classList.add('hidden');
      $('#app').classList.remove('hidden');
      connect();
    }
  }

  init();
})();