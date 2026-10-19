/* A frontend-only preview of the real landing component. No identity or API calls. */
import { landingView } from './views/auth.js';
import { toggleLanguage } from './i18n.js';
import { cycleTheme } from './theme.js';
const root = document.getElementById('app');
const ui = { designPreview:true, landingStep:0 };
const render = () => { root.innerHTML = landingView(ui); };
root.addEventListener('click', event => {
  const control = event.target.closest('[data-action]');
  if (!control) return;
  const action = control.dataset.action;
  if (action === 'landing-step') {
    const step = Number(control.dataset.step);
    if (![0,1,2].includes(step)) return;
    const keep = control.dataset.keep;
    ui.landingStep = step; render();
    root.querySelector(`[data-keep="${keep}"]`)?.focus({preventScroll:true});
  } else if (action === 'toggle-language') { toggleLanguage(); render(); }
  else if (action === 'cycle-theme') { cycleTheme(); render(); }
});
render();
