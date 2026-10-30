// The project list, as the board and the mini window show it: each project
// the personal assistant found (or the user added), how many sessions run in
// it now, and its to-do list, which can be typed into and ticked off here.
// The list itself lives in ~/.agents-home/projects.json (src/core/projects.js).

import { icon, badge, runningBadge, todoPips, isRunning } from './overview.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ORDER = { active: 0, paused: 1, done: 2 };

// The add form for a project (or for a new project), with its own error
// line, linked to the field so it is read out and found next to it.
function addForm({ op, project, id, label, placeholder, max, error }) {
  const err = error ? `<p class="form-error" id="${id}-err">${esc(error)}</p>` : '';
  return `<form class="proj-add" data-op="${op}"${project ? ` data-project="${esc(project)}"` : ''}>
      <label class="visually-hidden" for="${id}">${esc(label)}</label>
      <input id="${id}" name="text" placeholder="${esc(placeholder)}" autocomplete="off" maxlength="${max}"${error ? ` aria-invalid="true" aria-describedby="${id}-err"` : ''}>
      <button type="submit" class="icon-act" data-op="${op}"${project ? ` data-project="${esc(project)}"` : ''} title="${esc(label)}">${icon('plus')}<span class="visually-hidden">${esc(label)}</span></button></form>${err}`;
}

// opts: { privacy, open: Set of project ids shown in full, error: { where, text } }
// With privacy mode on, to-do wording is hidden like everything else that
// could name a file, a dataset or a case: items show as "To-do 3".
export function projectsHtml(projects, sessions, opts) {
  const list = [...(projects?.list ?? [])].sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || a.name.localeCompare(b.name));
  if (projects && projects.ok === false) {
    return '<p class="hint">The project list could not be read. See “Needs attention”.</p>';
  }
  const errFor = (where) => (opts.error?.where === where ? opts.error.text : '');
  const newProject = addForm({ op: 'add-project', id: 'proj-new', label: 'Add a project', placeholder: list.length ? 'Add a project' : 'Or add a project by name', max: 120, error: errFor('new') });
  if (!list.length) {
    return `<p class="hint">No projects yet. In Claude, ask your personal assistant to <strong>scan my computer for projects</strong>: it finds them, puts branch copies under their main project, and asks you to check the list before saving it.</p>${newProject}`;
  }
  const unconfirmed = list.filter((p) => !p.confirmed).length;
  const head = unconfirmed
    ? `<p class="proj-check">${icon('agent')}<span>Your assistant found ${unconfirmed} project${unconfirmed === 1 ? '' : 's'} to check. Confirm the ones you are working on.</span></p>` : '';
  const privacyNote = opts.privacy && list.some((p) => p.todos.length)
    ? '<p class="hint">To-do wording is hidden while “Hide file names and commands” is on.</p>' : '';
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
    const items = isOpen ? `<ul class="ptodos">${p.todos.map((t, i) => {
      const text = opts.privacy ? `To-do ${i + 1}` : t.text;
      return `<li class="${t.done ? 'completed' : ''}">
        <button type="button" class="tick" data-op="toggle-todo" data-project="${esc(p.id)}" data-todo="${esc(t.id)}" aria-pressed="${t.done}" title="${t.done ? 'Mark as not done' : 'Mark as done'}"><span class="pip ${t.done ? 'completed' : 'pending'}" aria-hidden="true"></span><span class="visually-hidden">Done: ${esc(text)}</span></button>
        <span class="ptext${opts.privacy ? ' hidden-text' : ''}" aria-hidden="true">${esc(text)}</span>
        ${t.by === 'agent' ? `<span class="by" title="Added by an agent">${icon('agent')}<span class="visually-hidden">Added by an agent</span></span>` : '<span></span>'}
        <button type="button" class="icon-act subtle" data-op="remove-todo" data-project="${esc(p.id)}" data-todo="${esc(t.id)}" title="Remove">${icon('close')}<span class="visually-hidden">Remove ${esc(text)}</span></button></li>`;
    }).join('')}</ul>
      ${addForm({ op: 'add-todo', project: p.id, id: `todo-${p.id}`, label: `Add a to-do to ${p.name}`, placeholder: 'Add a to-do', max: 300, error: errFor(p.id) })}` : '';
    return `<li class="pcard${p.confirmed ? '' : ' unconfirmed'}${isOpen ? ' open' : ''}" data-id="${esc(p.id)}">
      <div class="pcard-head">
        <button type="button" class="pname" data-op="open" data-project="${esc(p.id)}" aria-expanded="${isOpen}"${where}>${icon('project')}<span>${esc(p.name)}</span></button>
        <span class="badges">${badges}</span>
      </div>
      <div class="pcard-sub">${todos.total ? todoPips(todos) : '<span class="pip-n">No to-dos yet</span>'}
        ${p.confirmed ? '' : `<button type="button" class="confirm" data-op="confirm" data-project="${esc(p.id)}">${icon('check')}Confirm<span class="visually-hidden"> ${esc(p.name)}</span></button>`}</div>
      ${errFor(`card:${p.id}`) ? `<p class="form-error" role="alert">${esc(errFor(`card:${p.id}`))}</p>` : ''}
      ${items}</li>`;
  }).join('');
  return `${head}${privacyNote}<ul class="pcards">${cards}</ul>${newProject}`;
}

// Clicks and typing in a project list. `change(op)` saves (the app's
// bridge, or the demo's own copy) and resolves { ok, error }. Errors go to
// the form or card they came from.
export function wireProjects(root, { open, change, rerender, setError }) {
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-op]');
    if (!b || b.type === 'submit') return;
    const { op, project, todo } = b.dataset;
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
      { id: 'a', text: 'Draft the intro', done: true, by: 'you' }, { id: 'b', text: 'Tidy the loader tests', done: false, by: 'agent' }, { id: 'c', text: 'Write the release note', done: false, by: 'you' }] },
    { id: 'carm-calib', name: 'carm-calib', confirmed: true, status: 'active', copies: [], todos: [{ id: 'a', text: 'Re-run the fast test loop', done: false, by: 'agent' }] },
    { id: 'weekly-report', name: 'weekly-report', confirmed: true, status: 'active', copies: [], todos: [] },
    { id: 'garden-planner', name: 'garden-planner', confirmed: false, status: 'active', copies: [{ path: 'garden-planner-old' }, { path: 'garden-planner-v2' }], todos: [] },
  ];
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
    return { ok: true };
  };
  return { snapshot: () => ({ ok: true, list: list.map((p) => ({ ...p, todos: p.todos.map((t) => ({ ...t })) })) }), change };
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
