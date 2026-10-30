// The project list, as the board and the mini window show it: each project
// the personal assistant found (or the user added), how many sessions run in
// it now, and its to-do list, which can be typed into and ticked off here.
// The list itself lives in ~/.agents-home/projects.json (src/core/projects.js).

import { icon, badge, runningBadge, todoPips, isRunning } from './overview.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ORDER = { active: 0, paused: 1, done: 2 };

// Days are local calendar days, YYYY-MM-DD.
const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function dueLabel(due, today = new Date()) {
  const t = dayOf(today);
  const tomorrow = dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  if (due === t) return { text: 'Today', when: 'today' };
  if (due === tomorrow) return { text: 'Tomorrow', when: 'soon' };
  const [y, m, d] = due.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const text = date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(y !== today.getFullYear() ? { year: 'numeric' } : {}) });
  return due < t ? { text: `${text} · overdue`, when: 'overdue' } : { text, when: 'later' };
}

// Projects with open to-dos first (the soonest day first), then the ones
// with nothing to do; active before paused before done within each.
export function sortProjects(list) {
  const key = (p) => {
    const open = p.todos.filter((t) => !t.done);
    const soonest = open.map((t) => t.due).filter(Boolean).sort()[0] ?? '9999-99-99';
    return [open.length ? 0 : 1, soonest, ORDER[p.status] ?? 0, p.name.toLowerCase()];
  };
  return [...list].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  });
}

// Inside a project: open to-dos with a day (soonest first), open ones
// without, then the done ones; each group keeps the list's own order.
export function sortTodos(todos) {
  const rank = (t) => (t.done ? 2 : t.due ? 0 : 1);
  return todos.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t)
    || (rank(a.t) === 0 ? a.t.due.localeCompare(b.t.due) : 0) || a.i - b.i).map(({ t }) => t);
}

// The add form for a project (or for a new project), with its own error
// line, linked to the field so it is read out and found next to it.
function addForm({ op, project, id, label, placeholder, max, error }) {
  const err = error ? `<p class="form-error" id="${id}-err">${esc(error)}</p>` : '';
  return `<form class="proj-add" data-op="${op}"${project ? ` data-project="${esc(project)}"` : ''}>
      <label class="visually-hidden" for="${id}">${esc(label)}</label>
      <input id="${id}" name="text" placeholder="${esc(placeholder)}" autocomplete="off" maxlength="${max}"${error ? ` aria-invalid="true" aria-describedby="${id}-err"` : ''}>
      <button type="submit" class="icon-act" data-op="${op}"${project ? ` data-project="${esc(project)}"` : ''} title="${esc(label)}">${icon('plus')}<span class="visually-hidden">${esc(label)}</span></button></form>${err}`;
}

const hhmm = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, ${t}`;
};

// The personal assistant's question queue and its last scan
// (src/core/assistant.js), with `check` (projects it found for the user to
// confirm) in the same group. Nothing shows until its scan has run once.
// Questions are hidden like to-dos in privacy mode, as they can name a
// folder; the project badge is then the only context, so it shows only then.
function assistantHtml(a, list, privacy, check = '') {
  if (!a?.on) return '';
  const names = new Map(list.map((p) => [p.id, p.name]));
  const when = a.lastRun ? `Last scan ${hhmm(a.lastRun)}` : 'No scan yet';
  const status = a.failures ? `${when} · the last ${a.failures === 1 ? 'scan' : `${a.failures} scans`} failed` : when;
  const head = `<div class="asst-top">${icon('agent')}<h3 class="asst-head" id="asst-head">${a.questions.length ? 'Your assistant asks' : 'Your assistant has no questions'}</h3><span class="asst-when${a.failures ? ' warn' : ''}">${esc(status)}</span></div>`;
  const notes = [
    ...(a.failures && a.lastError && !privacy ? [`Last error: ${a.lastError}. Details are in scan.log in the assistant’s folder.`] : []),
    ...(a.failures && (!a.lastError || privacy) ? ['Details are in scan.log in the assistant’s folder.'] : []),
    ...(a.notes ?? []),
  ].map((n) => `<p class="hint asst-note">${esc(n)}</p>`).join('');
  const checkLine = check ? `<p class="hint asst-check">${check}</p>` : '';
  if (!a.questions.length) return `<section class="asst" aria-labelledby="asst-head">${head}${checkLine}${notes}</section>`;
  const items = a.questions.map((q, i) => {
    const project = privacy && q.project && names.get(q.project);
    return `<li><span class="asst-text${privacy ? ' hidden-text' : ''}">${esc(privacy ? `Question ${i + 1}` : q.text)}</span>${project ? `<span class="badge quiet" title="${esc(project)}">${esc(project)}</span>` : ''}</li>`;
  }).join('');
  const more = a.more ? `<li class="asst-more">${a.more} more question${a.more === 1 ? '' : 's'}</li>` : '';
  return `<section class="asst" aria-labelledby="asst-head">${head}<ul class="asst-q">${items}${more}</ul>
    <p class="hint">Answer in Claude by saying “answer the assistant”. Ticking a question’s to-do dismisses it.</p>${checkLine}${notes}</section>`;
}

// opts: { privacy, open: Set of project ids shown in full, error: { where, text } }
// With privacy mode on, to-do wording is hidden like everything else that
// could name a file, a dataset or a case: items show as "To-do 3".
export function projectsHtml(projects, sessions, opts) {
  const list = sortProjects(projects?.list ?? []);
  const unconfirmed = list.filter((p) => !p.confirmed).length;
  const checkText = unconfirmed ? `Your assistant found ${unconfirmed} project${unconfirmed === 1 ? '' : 's'} to check. Confirm the ones you are working on.` : '';
  const asks = assistantHtml(projects?.assistant, list, opts.privacy, checkText);
  if (projects && projects.ok === false) {
    return `${asks}<p class="hint">The project list could not be read. See “Needs attention”.</p>`;
  }
  const errFor = (where) => (opts.error?.where === where ? opts.error.text : '');
  const newProject = addForm({ op: 'add-project', id: 'proj-new', label: 'Add a project', placeholder: list.length ? 'Add a project' : 'Or add a project by name', max: 120, error: errFor('new') });
  if (!list.length) {
    return `${asks}<p class="hint">No projects yet. In Claude, ask your personal assistant to <strong>scan my computer for projects</strong>: it finds them, puts branch copies under their main project, and asks you to check the list before saving it.</p>${newProject}`;
  }
  // With the assistant's list showing, its "found N to check" line sits in it.
  const head = checkText && !asks ? `<p class="proj-check">${icon('agent')}<span>${checkText}</span></p>` : '';
  const privacyNote = opts.privacy && (list.some((p) => p.todos.length) || projects?.assistant?.questions?.length)
    ? '<p class="hint">Question and to-do wording is hidden while “Hide file names and commands” is on.</p>' : '';
  const cards = list.map((p) => {
    const live = sessions.filter((s) => s.projectId === p.id);
    const running = live.filter((s) => isRunning(s.status)).length;
    const done = p.todos.filter((t) => t.done).length;
    const todos = { total: p.todos.length, done, doing: 0, items: p.todos.map((t) => ({ status: t.done ? 'completed' : 'pending' })) };
    const isOpen = opts.open.has(p.id);
    const where = !opts.privacy && p.path ? ` title="${esc(p.path)}"` : '';
    const badges = [
      running ? runningBadge(running) : '',
      p.copies?.length ? badge('branch', p.copies.length, `${p.copies.length} branch cop${p.copies.length === 1 ? 'y' : 'ies'} or worktree${p.copies.length === 1 ? '' : 's'}`, { quiet: true }) : '',
      p.status !== 'active' ? `<span class="badge quiet">${esc(p.status === 'paused' ? 'Paused' : 'Done')}</span>` : '',
    ].join('');
    const items = isOpen ? `<ul class="ptodos">${sortTodos(p.todos).map((t, i) => {
      const text = opts.privacy ? `To-do ${i + 1}` : t.text;
      const due = t.due ? dueLabel(t.due) : null;
      const dateId = `date-${p.id}-${t.id}`;
      // A date chip that opens the calendar; the native picker does the rest.
      const when = t.done && !due ? '<span></span>' : `<span class="when">
          <button type="button" class="date-btn${due ? ` set ${due.when}` : ''}" data-op="pick-date" data-project="${esc(p.id)}" data-todo="${esc(t.id)}" title="${due ? `Planned for ${esc(due.text)} (click to change)` : 'Pick a day for this'}">${icon('calendar')}${due ? `<span>${esc(due.text)}</span>` : ''}<span class="visually-hidden">${due ? '' : 'Pick a day for '}${esc(text)}</span></button>
          <input type="date" class="date-input" id="${esc(dateId)}" data-project="${esc(p.id)}" data-todo="${esc(t.id)}" value="${esc(t.due ?? '')}" tabindex="-1" aria-hidden="true"></span>`;
      return `<li class="${t.done ? 'completed' : ''}">
        <button type="button" class="tick" data-op="toggle-todo" data-project="${esc(p.id)}" data-todo="${esc(t.id)}" aria-pressed="${t.done}" title="${t.done ? 'Mark as not done' : 'Mark as done'}"><span class="pip ${t.done ? 'completed' : 'pending'}" aria-hidden="true"></span><span class="visually-hidden">Mark as done: ${esc(text)}</span></button>
        <span class="ptext${opts.privacy ? ' hidden-text' : ''}" aria-hidden="true">${esc(text)}</span>
        ${when}
        ${t.by === 'agent' ? `<span class="by" title="Added by an agent">${icon('agent')}<span class="visually-hidden">Added by an agent</span></span>` : '<span></span>'}
        <button type="button" class="icon-act subtle" data-op="remove-todo" data-project="${esc(p.id)}" data-todo="${esc(t.id)}" title="Remove">${icon('close')}<span class="visually-hidden">Remove ${esc(text)}</span></button></li>`;
    }).join('')}</ul>
      ${addForm({ op: 'add-todo', project: p.id, id: `todo-${p.id}`, label: `Add a to-do to ${p.name}`, placeholder: 'Add a to-do', max: 300, error: errFor(p.id) })}` : '';
    return `<li class="pcard${p.confirmed ? '' : ' unconfirmed'}${isOpen ? ' open' : ''}" data-id="${esc(p.id)}">
      <div class="pcard-head">
        <button type="button" class="pname" data-op="open" data-project="${esc(p.id)}" aria-expanded="${isOpen}"${where}>${icon('project')}<span>${esc(p.name)}</span></button>
        <span class="badges">${badges}</span>
      </div>
      <div class="pcard-sub"><span class="sub-left">${todos.total ? todoPips(todos) : '<span class="pip-n">No to-dos yet</span>'}${(() => {
        const next = p.todos.filter((t) => !t.done && t.due).map((t) => t.due).sort()[0];
        if (!next) return '';
        const d = dueLabel(next);
        return `<span class="next-due ${d.when}" title="Next planned to-do">${icon('calendar')}${esc(d.text)}</span>`;
      })()}</span>
        ${p.confirmed ? '' : `<button type="button" class="confirm" data-op="confirm" data-project="${esc(p.id)}">${icon('check')}Confirm<span class="visually-hidden"> ${esc(p.name)}</span></button>`}</div>
      ${errFor(`card:${p.id}`) ? `<p class="form-error" role="alert">${esc(errFor(`card:${p.id}`))}</p>` : ''}
      ${items}</li>`;
  }).join('');
  return `${asks}${head}${privacyNote}<ul class="pcards">${cards}</ul>${newProject}`;
}

// Clicks and typing in a project list. `change(op)` saves (the app's
// bridge, or the demo's own copy) and resolves { ok, error }. Errors go to
// the form or card they came from.
export function wireProjects(root, { open, change, rerender, setError }) {
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-op]');
    if (!b || b.type === 'submit') return;
    const { op, project, todo } = b.dataset;
    if (op === 'pick-date') {
      // Open the calendar for that to-do's hidden date field.
      const input = b.parentElement.querySelector('input.date-input');
      try {
        input.showPicker();
      } catch {
        // Older engines without showPicker: focus the field instead.
        input.focus();
      }
      return;
    }
    if (op === 'open') {
      if (open.has(project)) open.delete(project);
      else open.add(project);
      setError(undefined);
      rerender(); // focus stays on the name (paint keeps it)
      return;
    }
    const res = await change({ op, project, todo });
    setError(res.ok ? undefined : { where: `card:${project}`, text: res.error });
    // After a remove or a confirm the button is gone: go back to the name.
    const back = op === 'remove-todo' || op === 'confirm';
    rerender();
    if (back) root.querySelector(`.pname[data-project="${CSS.escape(project)}"]`)?.focus();
  });
  root.addEventListener('change', async (e) => {
    const input = e.target.closest?.('input.date-input');
    if (!input) return;
    const { project, todo } = input.dataset;
    const res = await change({ op: 'set-date', project, todo, date: input.value });
    setError(res.ok ? undefined : { where: `card:${project}`, text: res.error });
    rerender();
    root.querySelector(`.date-btn[data-project="${CSS.escape(project)}"][data-todo="${CSS.escape(todo)}"]`)?.focus();
  });
  root.addEventListener('submit', async (e) => {
    const form = e.target.closest('form.proj-add');
    if (!form) return;
    e.preventDefault();
    const text = form.elements.text.value;
    const { op, project } = form.dataset;
    const res = await change(op === 'add-project' ? { op, name: text } : { op, project, text });
    setError(res.ok ? undefined : { where: project ?? 'new', text: res.error });
    if (res.ok) form.elements.text.value = '';
    rerender();
    root.querySelector(project ? `#todo-${CSS.escape(project)}` : '#proj-new')?.focus();
  });
}

// The demo keeps its projects in memory: the same changes, never saved.
export function demoProjects() {
  const list = [
    { id: 'spine-seg', name: 'spine-seg', confirmed: true, status: 'active', copies: [{ path: 'spine-seg-wt-docs' }], todos: [
      { id: 'a', text: 'Draft the intro', done: true, by: 'you' }, { id: 'b', text: 'Tidy the loader tests', done: false, by: 'agent', due: dayOf(new Date()) }, { id: 'c', text: 'Write the release note', done: false, by: 'you' }] },
    { id: 'carm-calib', name: 'carm-calib', confirmed: true, status: 'active', copies: [], todos: [{ id: 'a', text: 'Re-run the fast test loop', done: false, by: 'agent', due: dayOf(new Date(Date.now() + 3 * 86_400_000)) }] },
    { id: 'weekly-report', name: 'weekly-report', confirmed: true, status: 'active', copies: [], todos: [] },
    { id: 'garden-planner', name: 'garden-planner', confirmed: false, status: 'active', copies: [{ path: 'garden-planner-old' }, { path: 'garden-planner-v2' }], todos: [] },
  ];
  list[2].todos.push({ id: 'q', text: 'Assistant asks: weekly-report has had no commits for 16 days. Mark it paused?', done: false, by: 'agent' });
  const assistant = {
    on: true, lastRun: new Date(Date.now() - 6 * 60_000).toISOString(), failures: 0, more: 0, problems: [],
    questions: [
      { key: 'pause', project: 'weekly-report', text: 'weekly-report has had no commits for 16 days. Mark it paused?' },
      { key: 'new', text: 'I found a project folder that is not on your list: tide-tables (in Documents). Add it?' },
    ],
  };
  let n = 0;
  const change = (c) => {
    const p = list.find((x) => x.id === c.project);
    if (c.op === 'add-project') {
      const name = String(c.name ?? '').trim();
      if (!name) return { ok: false, error: 'Give the project a name.' };
      list.push({ id: `demo-${++n}`, name, confirmed: true, status: 'active', copies: [], todos: [] });
    } else if (!p) return { ok: false, error: 'That project is no longer on the list.' };
    else if (c.op === 'add-todo') {
      const text = String(c.text ?? '').trim();
      if (!text) return { ok: false, error: 'Type the to-do first.' };
      p.todos.push({ id: `d${++n}`, text, done: false, by: 'you' });
    } else if (c.op === 'toggle-todo') {
      const t = p.todos.find((x) => x.id === c.todo);
      if (t) t.done = !t.done;
    } else if (c.op === 'remove-todo') p.todos = p.todos.filter((x) => x.id !== c.todo);
    else if (c.op === 'confirm') p.confirmed = true;
    else if (c.op === 'set-date') {
      const t = p.todos.find((x) => x.id === c.todo);
      if (t) { if (c.date) t.due = c.date; else delete t.due; }
    }
    return { ok: true };
  };
  return { snapshot: () => ({ ok: true, list: list.map((p) => ({ ...p, todos: p.todos.map((t) => ({ ...t })) })), assistant }), change };
}

// A way to find the same control again after a redraw: its id, or the
// data attributes that name what it acts on.
function keyOf(el) {
  if (!el || el === document.body) return undefined;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const attrs = ['op', 'project', 'todo', 'key'].filter((k) => el.dataset?.[k] !== undefined)
    .map((k) => `[data-${k}="${CSS.escape(el.dataset[k])}"]`).join('');
  return attrs ? `${el.tagName.toLowerCase()}${attrs}` : undefined;
}

// Redraws a list only when it changed, keeping keyboard focus, what is being
// typed and where the caret is.
export function paint(root, html) {
  if (root.dataset.sig === html) return;
  const active = root.contains(document.activeElement) ? document.activeElement : null;
  const key = keyOf(active);
  const keep = active && 'value' in active && active.tagName === 'INPUT' ? { value: active.value, start: active.selectionStart, end: active.selectionEnd } : null;
  root.innerHTML = html;
  root.dataset.sig = html;
  if (!key) return;
  const el = root.querySelector(key);
  if (!el) return;
  if (keep) el.value = keep.value;
  el.focus({ preventScroll: true });
  if (keep && el.setSelectionRange) el.setSelectionRange(keep.start, keep.end);
}
