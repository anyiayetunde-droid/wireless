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
  let mode = 'keys'; // keys | mouse | text
  let layer = 'main'; // main | sym | func
  let shift = false; // one-shot shift latch (next letter becomes uppercase)
  let caps = false;
  let lastShiftTap = 0;

  let repeatTimer = null;

  // ---------- layout definitions ----------
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

  const REPEATABLE = new Set(['Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab']);

  // ---------- PWA install ----------
  let installPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('#installBtn').classList.remove('hidden');
  });

  $('#installBtn').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('#installBtn').classList.add('hidden');
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    $('#installBtn').classList.add('hidden');
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline/install support is best-effort */
    });
  }

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
      send({ t: 'hello', pin });
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
          $('#connectScreen').classList.remove('hidden');
          $('#app').classList.add('hidden');
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
        // Transient drop: return to the connect screen and auto-reconnect.
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
    denied = true; // stop auto-reconnect
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

  function showConnectOk(text) {
    const el = $('#connectStatus');
    el.textContent = text || '';
    el.classList.add('ok');
  }

  function vibrate(ms) {
    try {
      if (navigator.vibrate) navigator.vibrate(ms);
    } catch {
      /* ignore */
    }
  }

  // ---------- keyboard ----------
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
        if (!isChar && (k === 'F1' || (k && /^F\d+$/.test(k)) || def.label)) cls.push('fn');
        if (!isChar && def.wide) cls.push('wide');
        if (!isChar && k === 'Space') cls.push('wider');
        if (isChar && !/^[a-zA-Z0-9]$/.test(def)) cls.push('alt');
        if (!isChar && ARROW_ROW.includes(def)) cls.push('arrow-row');
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

  function startRepeat(def) {
    stopRepeat();
    repeatTimer = setTimeout(function tick() {
      if (def && def.k) {
        send({ t: 'key', k: def.k });
        vibrate(5);
      }
      repeatTimer = setTimeout(tick, 55);
    }, 400);
  }

  function stopRepeat() {
    clearTimeout(repeatTimer);
    repeatTimer = null;
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

  function consumeShift() {
    if (shift) {
      shift = false;
      renderKeyboard();
    }
  }

  function onKeyDown(def) {
    if (typeof def === 'string') {
      let ch = def;
      if (/^[a-z]$/.test(ch) && (shift || caps)) ch = ch.toUpperCase();
      send({ t: 'key', k: ch });
      vibrate(8);
      if (/^[a-zA-Z]$/.test(ch)) consumeShift();
      return;
    }
    if (def.combo) {
      send({ t: 'combo', mods: def.combo.slice(0, -1), k: def.combo[def.combo.length - 1] });
      vibrate(8);
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
    vibrate(8);
    if (REPEATABLE.has(def.k)) startRepeat(def);
  }

  function bindKeyboard() {
    const kb = $('#keyboard');
    const defAt = (el) => {
      const i = el && el.dataset ? Number(el.dataset.i) : -1;
      return kb._defs && Number.isInteger(i) && kb._defs[i] !== undefined ? kb._defs[i] : null;
    };

    kb.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const def = defAt(e.target.closest('.key'));
      if (def) onKeyDown(def);
    }, { passive: false });

    kb.addEventListener('touchend', (e) => {
      e.preventDefault();
      stopRepeat();
    }, { passive: false });
    kb.addEventListener('touchcancel', stopRepeat, { passive: false });

    kb.addEventListener('mousedown', (e) => {
      const def = defAt(e.target.closest('.key'));
      if (def) onKeyDown(def);
    });
    kb.addEventListener('mouseup', stopRepeat);
  }

  // ---------- mouse mode ----------
  const pad = $('#pad');
  const pointers = new Map();
  let padMoved = false;
  let padDragging = false;
  let scrollActive = false;
  let moveAcc = { x: 0, y: 0 };
  let moveTimer = null;

  function queueMove(dx, dy) {
    moveAcc.x += dx;
    moveAcc.y += dy;
    if (!moveTimer) moveTimer = setTimeout(flushMove, 16);
  }

  function flushMove() {
    moveTimer = null;
    const dx = Math.round(moveAcc.x);
    const dy = Math.round(moveAcc.y);
    moveAcc.x = 0;
    moveAcc.y = 0;
    if (dx || dy) send({ t: 'mouse', dx, dy });
  }

  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      padMoved = false;
      scrollActive = false;
    }
  });

  pad.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (Math.abs(dx) + Math.abs(dy) < 1) return;
    if (pointers.size === 1) {
      if (!padMoved && Math.hypot(dx, dy) > 8) padMoved = true;
      if (padMoved) {
        if (!padDragging) {
          send({ t: 'mouse', btn: 'left', down: true });
          padDragging = true;
        }
        queueMove(dx, dy);
      }
    } else if (pointers.size === 2) {
      scrollActive = true;
      if (dy) send({ t: 'scroll', dy: Math.round(dy * 1.2) });
    }
  });

  pad.addEventListener('pointerup', (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      flushMove();
      if (scrollActive) {
        scrollActive = false;
        return;
      }
      if (padDragging) {
        send({ t: 'mouse', btn: 'left', down: false });
        padDragging = false;
        return;
      }
      if (!padMoved) {
        send({ t: 'mouse', btn: 'left', down: true });
        send({ t: 'mouse', btn: 'left', down: false });
      }
    }
  });

  pad.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    if (padDragging) {
      send({ t: 'mouse', btn: 'left', down: false });
      padDragging = false;
    }
  });

  function bindMouseButtons() {
    const hold = (btnEl) => {
      let timer = null;
      const down = (e) => {
        e.preventDefault();
        send({ t: 'mouse', btn: btnEl.dataset.btn, down: true });
        vibrate(5);
      };
      const up = (e) => {
        e.preventDefault();
        send({ t: 'mouse', btn: btnEl.dataset.btn, down: false });
        clearTimeout(timer);
      };
      btnEl.addEventListener('touchstart', down, { passive: false });
      btnEl.addEventListener('touchend', up, { passive: false });
      btnEl.addEventListener('touchcancel', up, { passive: false });
      btnEl.addEventListener('mousedown', down);
      btnEl.addEventListener('mouseup', up);
      btnEl.addEventListener('mouseleave', up);
    };
    document.querySelectorAll('.mouse-btn[data-btn]').forEach(hold);

    const scrollBtn = (el, dir) => {
      let timer = null;
      const down = (e) => {
        e.preventDefault();
        send({ t: 'scroll', dy: dir });
        timer = setInterval(() => send({ t: 'scroll', dy: dir }), 90);
      };
      const up = (e) => {
        e.preventDefault();
        clearInterval(timer);
      };
      el.addEventListener('touchstart', down, { passive: false });
      el.addEventListener('touchend', up, { passive: false });
      el.addEventListener('touchcancel', up, { passive: false });
      el.addEventListener('mousedown', down);
      el.addEventListener('mouseup', up);
      el.addEventListener('mouseleave', up);
    };
    scrollBtn($('#scrollUp'), 3);
    scrollBtn($('#scrollDown'), -3);
  }

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
        status.textContent = `✓ Typed ${text.length} characters on your computer.`;
      }, 300);
    });
    $('#clearTextBtn').addEventListener('click', () => {
      $('#textInput').value = '';
      $('#textStatus').textContent = '';
    });
  }

  // ---------- mode switching ----------
  function setMode(m) {
    mode = m;
    stopRepeat();
    document.querySelectorAll('.mode-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === m);
    });
    $('#keyboardMode').classList.toggle('hidden', m !== 'keys');
    $('#mouseMode').classList.toggle('hidden', m !== 'mouse');
    $('#textMode').classList.toggle('hidden', m !== 'text');
  }

  // ---------- wire up ----------
  function init() {
    bindKeyboard();
    bindMouseButtons();
    bindTextMode();

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

    renderKeyboard();
    setMode('keys');

    if (urlPin) {
      $('#connectScreen').classList.add('hidden');
      $('#app').classList.remove('hidden');
      connect();
    } else {
      setStatus('disconnected');
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !authed && !denied) connect();
    });
  }

  init();
})();