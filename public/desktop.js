'use strict';

(function () {
  const $ = (s) => document.querySelector(s);
  let lastPin = '';

  async function refresh() {
    let st = null;
    try {
      st = await (await fetch('/api/status', { cache: 'no-store' })).json();
    } catch {
      return;
    }

    const pinEl = $('#pin');
    if (st.pin && st.pin !== lastPin) {
      lastPin = st.pin;
      pinEl.textContent = st.pin;
      const url = location.origin + '/';
      $('#lanUrl').textContent = location.hostname === '127.0.0.1' ? url : location.origin + '/';
      $('#openBrowser').href = location.origin + '/';
    }

    $('#clients').textContent = String(st.clients || 0);

    const rec = $('#receiver');
    if (st.receiver) {
      rec.textContent = 'Yes';
      rec.className = 'v on';
    } else {
      rec.textContent = 'No';
      rec.className = 'v off';
    }

    const d = st.driver || {};
    $('#driver').textContent = d.name ? d.name[0].toUpperCase() + d.name.slice(1) : '—';
    $('#driverHint').textContent = d.hint || '';

    const pill = $('#driverPill');
    if (d.name === 'mock') {
      pill.textContent = 'MOCK MODE';
      pill.className = 'pill warn';
      $('#mockBanner').classList.remove('hidden');
    } else if (d.ok === false) {
      pill.textContent = 'DRIVER ISSUE';
      pill.className = 'pill err';
    } else {
      pill.textContent = 'LIVE';
      pill.className = 'pill ok';
    }

    // The version pill is filled once below; don't clobber it on every tick.
  }

  $('#copyPin').addEventListener('click', async () => {
    const btn = $('#copyPin');
    try {
      await navigator.clipboard.writeText(lastPin);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = lastPin;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    btn.textContent = 'Copied ✓';
    btn.classList.add('done');
    setTimeout(() => {
      btn.textContent = 'Copy PIN';
      btn.classList.remove('done');
    }, 1400);
  });

  // The server exposes the version on /api/downloads (not /api/status), so
  // fetch it once and stamp the pill. Left blank rather than wrong on failure.
  (async () => {
    try {
      const info = await (await fetch('/api/downloads', { cache: 'no-store' })).json();
      if (info && info.version) $('#verPill').textContent = 'v' + info.version;
    } catch {
      /* offline — leave the pill empty */
    }
  })();

  refresh();
  setInterval(refresh, 2000);
})();