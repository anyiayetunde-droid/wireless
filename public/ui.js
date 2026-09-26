/* =====================================================================
   Wireless — shared page chrome
   One implementation of the things every page needs, so no page has to
   re-invent them:
     - the back button (go back if there is history, else follow its href)
     - the current page marked in the top-bar nav
   Include with <script src="/ui.js" defer></script> before </body>.
   Pages keep ownership of what is genuinely theirs (the version readout,
   their own data fetches), so this file stays small and predictable.
   ===================================================================== */

(function () {
  'use strict';

  /**
   * Back buttons: every page renders <a class="back-btn" href="/">…</a>.
   * If the visitor arrived from elsewhere in the app, going back is what they
   * expect; when the page was opened directly (no history) we follow the href
   * so the control never does nothing.
   */
  function initBackButtons() {
    for (const btn of document.querySelectorAll('.back-btn')) {
      btn.addEventListener('click', (event) => {
        if (window.history.length > 1) {
          event.preventDefault();
          window.history.back();
        }
      });
    }
  }

  /** Mark the top-bar link for the page currently open. */
  function initNav() {
    const here = window.location.pathname.replace(/\/index\.html$/, '/') || '/';
    for (const link of document.querySelectorAll('.topbar-nav a, .nav-links a')) {
      const target = new URL(link.getAttribute('href'), window.location.origin).pathname;
      if (target === here) link.setAttribute('aria-current', 'page');
    }
  }

  function init() {
    initBackButtons();
    initNav();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
