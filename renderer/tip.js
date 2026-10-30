// Quick hover labels for icon-only controls, in both windows. Anything with a
// `title` (or `data-tip`) shows its words in a small label as soon as the
// pointer rests on it or keyboard focus reaches it, instead of the slow
// system tooltip. The title moves to `data-tip` so the two never show together;
// screen readers keep the hidden text or aria-label each control already has.

export function installTips(doc = document) {
  const tip = doc.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('aria-hidden', 'true');
  doc.body.append(tip);
  let shownFor;
  let timer;

  const words = (el) => {
    if (el.hasAttribute('title')) {
      el.dataset.tip = el.getAttribute('title');
      el.removeAttribute('title');
    }
    return el.dataset.tip;
  };
  const place = (el) => {
    const r = el.getBoundingClientRect();
    tip.style.left = '0px';
    tip.style.top = '0px';
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.min(Math.max(6, r.left + r.width / 2 - w / 2), innerWidth - w - 6);
    const above = r.top - h - 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${above >= 4 ? above : r.bottom + 8}px`;
  };
  const show = (el, delay) => {
    const text = words(el);
    if (!text) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!el.isConnected) return;
      tip.textContent = text;
      tip.classList.add('on');
      place(el);
      shownFor = el;
    }, delay);
  };
  const hide = () => {
    clearTimeout(timer);
    tip.classList.remove('on');
    shownFor = undefined;
  };
  // SVG scene parts keep their own <title> elements; only HTML controls here.
  const target = (e) => e.target.closest?.('[title], [data-tip]');
  doc.addEventListener('pointerover', (e) => {
    const el = target(e);
    if (el && el !== shownFor && !(el instanceof SVGElement)) show(el, 220);
    else if (!el) hide();
  });
  doc.addEventListener('pointerout', (e) => {
    if (shownFor && !shownFor.contains(e.relatedTarget)) hide();
  });
  doc.addEventListener('focusin', (e) => {
    const el = target(e);
    if (el && el.matches(':focus-visible') && !(el instanceof SVGElement)) show(el, 0);
  });
  doc.addEventListener('focusout', hide);
  doc.addEventListener('pointerdown', hide);
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  addEventListener('scroll', hide, true);
  // A redraw may remove the control under the label.
  setInterval(() => { if (shownFor && !shownFor.isConnected) hide(); }, 300);
}
