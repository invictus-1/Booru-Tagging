// Booru Suite — header tabs. Tagger is its own view; Renamer / Tag Merger /
// Eagle Sync share the toolkit view (and its progress + log column).
(() => {
  'use strict';

  const tabs = [...document.querySelectorAll('.suite-tab')];
  const views = { tagger: document.getElementById('view-tagger'), toolkit: document.getElementById('view-toolkit') };
  let current = 'tagger';

  function show(view) {
    if (view !== 'tagger') {
      // The toolkit refuses to switch tools mid-job (they share one status
      // column); the Tagger tab is always reachable.
      if (!window.__toolkit.select(view)) return false;
    }
    current = view;
    views.tagger.classList.toggle('hidden', view !== 'tagger');
    views.toolkit.classList.toggle('hidden', view === 'tagger');
    for (const t of tabs) t.classList.toggle('active', t.dataset.view === view);
    try { localStorage.setItem('suite-tab', view); } catch { /* fine */ }
    return true;
  }

  for (const t of tabs) t.onclick = () => show(t.dataset.view);

  // Busy dots + blocked tools, refreshed lightly.
  function refreshBadges() {
    const tk = window.__toolkit;
    const tkTool = tk.runningTool();
    for (const t of tabs) {
      const v = t.dataset.view;
      const busy = v === 'tagger' ? window.__tagger.isRunning() : tkTool === v;
      t.classList.toggle('busy', busy);
      const blocked = v !== 'tagger' && tkTool && tkTool !== v;
      t.classList.toggle('blocked', Boolean(blocked));
      t.title = blocked ? 'Finish or cancel the running job in the other tool first' : '';
    }
  }
  setInterval(refreshBadges, 500);

  let saved = 'tagger';
  try { saved = localStorage.getItem('suite-tab') || 'tagger'; } catch { /* fine */ }
  if (!show(saved)) show('tagger');
})();
