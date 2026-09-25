// Assistant mode in the page: the Front desk where people type a task, the
// list of their tasks with the answers, and the API key in Settings. The
// work itself happens in the main process (electron/assistant.js); this
// module only asks for it and shows what comes back in the snapshot.

const $ = (id) => document.getElementById(id);

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// A small, safe Markdown subset for answers: headings, bullet and numbered
// lists, tables, bold, italics and inline code. Everything is escaped first.
export function renderAnswer(text) {
  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list; // 'ul' | 'ol'
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
    if (list) out.push(`</${list}>`);
    list = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const table = /^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '');
    if (table) {
      flush();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 1;
      const rows = [];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push(`<h4>${inline(h[2])}</h4>`);
    } else if (ul || ol) {
      if (para.length) {
        out.push(`<p>${para.map(inline).join('<br>')}</p>`);
        para = [];
      }
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) {
        if (list) out.push(`</${list}>`);
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((ul ?? ol)[1])}</li>`);
    } else if (!line.trim()) {
      flush();
    } else {
      if (list) {
        out.push(`</${list}>`);
        list = undefined;
      }
      para.push(line);
    }
  }
  flush();
  return out.join('');
}

// Rough cost of a typical task (about 1,500 words in, 600 out) per level, to
// help people choose. Real costs show on every finished task.
const TYPICAL = {
  quick: 'about $0.01',
  standard: 'about $0.01–0.03',
  deep: 'about $0.03–0.08',
};

const STATUS = {
  triage: 'Triage is reading your task',
  working: 'Working on it',
  checking: 'The checker is looking it over',
  done: 'Done',
  error: 'Did not complete',
  stopped: 'Stopped',
};
const TEAM_NAMES = { writer: 'Writer', summariser: 'Summariser', planner: 'Planner', 'data-helper': 'Data helper', helper: 'General helper', checker: 'Checker', coach: 'Coach', teacher: 'Teacher' };
const DEFAULT_PLACEHOLDER = 'e.g. Draft a friendly email asking the team to send their timesheets by Friday. Or paste a document and ask for a summary.';

function money(v) {
  if (!v) return '$0.00';
  return v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`;
}

export function createFrontDesk({ bridge, openSettings, onChange }) {
  const api = bridge.assistant;
  let status; // from the main process
  let level = 'standard';
  let skill = ''; // '' lets triage choose
  let pending; // { text, level, findings } waiting for the user's confirmation
  let deskError = '';
  let keyError = '';
  let keyNote = '';
  let lastJobs = '';
  let jobs = [];

  async function refresh() {
    status = api ? await api.status() : undefined;
    renderDesk();
    renderSettings();
    onChange?.();
  }

  function team() {
    return status?.team ?? [];
  }

  // ---- Settings → Assistant ---------------------------------------------------

  function renderSettings() {
    const box = $('assistant-settings');
    if (!api) {
      box.innerHTML = '<p class="hint">The desktop app runs the assistant; this preview cannot.</p>';
      return;
    }
    const key = status?.hasKey
      ? `<p class="hint">Your API key ending ${escapeHtml(status.keyHint)} is saved, encrypted by Windows for your account only.</p>
         <div class="form-actions"><button type="button" class="link-btn danger" id="as-key-remove">Remove key</button></div>`
      : `<p class="hint">Assistant mode needs your own Anthropic API key. Create one at console.anthropic.com, under API keys. Usage is billed to your Anthropic account (a Claude.ai plan does not cover it).</p>
         <form class="add-row" id="as-key-form">
           <label class="visually-hidden" for="as-key">API key</label>
           <input id="as-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…">
           <button class="button" type="submit">Save</button>
         </form>
         ${status && !status.canStoreKey ? '<p class="form-error">This computer offers no secure place for the key, so it cannot be saved.</p>' : ''}`;
    box.innerHTML = `${key}
      ${keyError ? `<p class="form-error" role="alert">${escapeHtml(keyError)}</p>` : ''}
      ${keyNote ? `<p class="hint" role="status">${escapeHtml(keyNote)}</p>` : ''}
      <p class="hint">Tasks and any text you paste are sent to Anthropic to be answered. Answers stay on this computer only until the app closes.</p>`;
  }

  $('assistant-settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('as-key');
    keyError = '';
    keyNote = 'Checking the key with Anthropic…';
    renderSettings();
    const res = await api.setKey(input?.value ?? '');
    keyNote = res.ok ? 'Key saved. You can use the Front desk now.' : '';
    keyError = res.ok ? '' : res.error;
    await refresh();
    if (!res.ok) $('as-key')?.focus();
  });
  $('assistant-settings').addEventListener('click', async (e) => {
    if (e.target.id !== 'as-key-remove') return;
    const res = await api.clearKey();
    keyError = res.ok ? '' : res.error;
    keyNote = res.ok ? 'Key removed from this computer.' : '';
    await refresh();
  });

  // ---- the Front desk ------------------------------------------------------------

  function renderDesk() {
    const body = $('fd-form');
    if (!api) {
      body.innerHTML = '<p class="empty">Assistant mode runs in the desktop app. This browser preview can only show Monitor mode.</p>';
      return;
    }
    if (!status?.hasKey) {
      body.innerHTML = `<p class="empty">To use the built-in team, add your Anthropic API key once in Settings.</p>
        <button type="button" class="button" id="fd-open-settings">Add API key</button>`;
      return;
    }
    if (body.querySelector('#fd-task')) {
      renderSkills();
      renderLevels();
      renderWarning();
      return;
    }
    body.innerHTML = `<form id="fd-send" class="fd-form">
      <fieldset class="chips"><legend>How should the team work?</legend><div class="options" id="fd-skills"></div></fieldset>
      <p class="hint" id="fd-skill-hint"></p>
      <label class="field" for="fd-task">What do you need?
        <textarea id="fd-task" rows="5" maxlength="60000" placeholder="${escapeHtml(DEFAULT_PLACEHOLDER)}"></textarea></label>
      <fieldset class="chips"><legend>Reasoning</legend><div class="options" id="fd-levels"></div></fieldset>
      <p class="hint" id="fd-level-hint"></p>
      <div id="fd-warning"></div>
      <div class="form-actions"><button type="submit" class="button" id="fd-submit">Send to the team</button><span class="hint">Ctrl+Enter</span></div>
    </form>`;
    renderSkills();
    renderLevels();
    renderWarning();
  }

  function renderSkills() {
    const list = [{ id: '', name: 'Automatic', blurb: 'Triage reads your task and picks the right teammate.' }, ...(status?.skills ?? [])];
    $('fd-skills').innerHTML = list.map((k) => `<label class="chip"><input type="radio" name="fd-skill" value="${k.id}" ${k.id === skill ? 'checked' : ''}>${escapeHtml(k.name)}</label>`).join('');
    const k = list.find((x) => x.id === skill);
    $('fd-skill-hint').textContent = k?.blurb ?? '';
    $('fd-task').placeholder = k?.placeholder ?? DEFAULT_PLACEHOLDER;
  }

  function renderLevels() {
    const levels = status?.levels ?? {};
    $('fd-levels').innerHTML = Object.entries(levels).map(([id, l]) => `<label class="chip"><input type="radio" name="fd-level" value="${id}" ${id === level ? 'checked' : ''}>${escapeHtml(l.name)}</label>`).join('');
    const l = levels[level];
    $('fd-level-hint').textContent = l ? `${l.blurb} Typical task: ${TYPICAL[level]}.` : '';
  }

  function renderWarning() {
    const box = $('fd-warning');
    if (!box) return;
    if (pending) {
      box.innerHTML = `<div class="fd-warn" role="alertdialog" aria-labelledby="fd-warn-h">
        <p id="fd-warn-h"><strong>This looks like it may identify a patient.</strong> It would be sent to Anthropic. Remove anything that should not leave, or send it if you are allowed to.</p>
        <ul>${pending.findings.map((f) => `<li>${escapeHtml(f.label)}: <code>${escapeHtml(f.text)}</code></li>`).join('')}</ul>
        <div class="form-actions">
          <button type="button" class="link-btn" id="fd-edit">Edit first</button>
          <button type="button" class="button danger" id="fd-send-anyway">Send anyway</button>
        </div></div>`;
      return;
    }
    box.innerHTML = deskError ? `<p class="form-error" role="alert">${escapeHtml(deskError)}</p>` : '';
  }

  async function send(confirmed = false) {
    const textarea = $('fd-task');
    const text = pending?.text ?? textarea.value;
    const lvl = pending?.level ?? level;
    const sk = pending?.skill ?? skill;
    deskError = '';
    const res = await api.run({ text, level: lvl, skill: sk, confirmed });
    if (res.needsConfirm) {
      pending = { text, level: lvl, skill: sk, findings: res.findings };
      renderWarning();
      $('fd-send-anyway')?.focus();
      return;
    }
    pending = undefined;
    if (!res.ok) {
      deskError = res.error;
      renderWarning();
      return;
    }
    textarea.value = '';
    renderWarning();
  }

  $('fd-form').addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  $('fd-form').addEventListener('keydown', (e) => {
    if (e.target.id === 'fd-task' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  });
  $('fd-form').addEventListener('change', (e) => {
    if (e.target.name === 'fd-skill') {
      skill = e.target.value;
      renderSkills();
      $('fd-skills').querySelector(`input[value="${skill}"]`)?.focus();
      return;
    }
    if (e.target.name !== 'fd-level') return;
    level = e.target.value;
    renderLevels();
    $('fd-levels').querySelector(`input[value="${level}"]`)?.focus();
  });
  $('fd-form').addEventListener('click', (e) => {
    if (e.target.id === 'fd-open-settings') openSettings('as-key');
    else if (e.target.id === 'fd-send-anyway') send(true);
    else if (e.target.id === 'fd-edit') {
      pending = undefined;
      renderWarning();
      $('fd-task')?.focus();
    }
  });

  // ---- the task list -----------------------------------------------------------------

  let replyPending; // { id, text, findings } a reply waiting for confirmation
  const replyErrors = new Map(); // job id -> message

  // The conversation after the first message: answers, and the user's replies.
  function conversation(j, running) {
    const turns = (j.turns ?? []).slice(1);
    // While an answer streams, the settled turns are shown plus the live text.
    const settled = running && turns.at(-1)?.role === 'assistant' ? turns.slice(0, -1) : turns;
    const parts = settled.map((t) => (t.role === 'user'
      ? `<div class="turn you"><span class="who">You</span> ${escapeHtml(t.text)}</div>`
      : `<div class="answer">${renderAnswer(t.text)}</div>`));
    if ((running || !turns.length) && j.answer) parts.push(`<div class="answer">${renderAnswer(j.answer)}</div>`);
    return parts.join('');
  }

  function replyBox(j) {
    const conversational = status?.skills?.find((k) => k.id === j.skill)?.conversational;
    const warn = replyPending?.id === j.id
      ? `<div class="fd-warn" role="alertdialog"><p><strong>This looks like it may identify a patient.</strong> It would be sent to Anthropic.</p>
          <ul>${replyPending.findings.map((f) => `<li>${escapeHtml(f.label)}: <code>${escapeHtml(f.text)}</code></li>`).join('')}</ul>
          <div class="form-actions"><button type="button" class="link-btn" data-reply-edit="${j.id}">Edit first</button>
          <button type="button" class="button danger" data-reply-anyway="${j.id}">Send anyway</button></div></div>`
      : '';
    const err = replyErrors.get(j.id);
    return `<form class="reply" data-reply="${j.id}">
      <label class="visually-hidden" for="reply-${j.id}">Reply</label>
      <textarea id="reply-${j.id}" rows="2" placeholder="${conversational ? 'Your answer…' : 'Ask for changes or a follow-up, e.g. “make it shorter”'}"></textarea>
      ${warn}${err ? `<p class="form-error" role="alert">${escapeHtml(err)}</p>` : ''}
      <button type="submit" class="button small">Reply</button></form>`;
  }

  function renderJobs(list) {
    jobs = list ?? [];
    const sig = JSON.stringify([jobs.map((j) => [j.id, j.status, j.answer?.length, j.turns?.length, j.error, j.note]), replyPending?.id, [...replyErrors]]);
    if (sig === lastJobs) return;
    lastJobs = sig;
    const box = $('fd-tasks');
    // Keep what the user is typing in any reply box across the redraw.
    const drafts = new Map([...box.querySelectorAll('.reply textarea')].map((t) => [t.id, t.value]));
    const focused = document.activeElement?.id;
    if (!jobs.length) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = [...jobs].reverse().map((j) => {
      const running = !['done', 'error', 'stopped'].includes(j.status);
      const who = j.specialist ? ` · ${TEAM_NAMES[j.specialist] ?? j.specialist}${j.checkerChanged ? ', corrected by the Checker' : ''}` : '';
      const cost = j.tokens?.total ? ` · ${j.tokens.total.toLocaleString()} tokens, ${money(j.cost)}` : '';
      const actions = running
        ? `<button type="button" class="link-btn" data-stop="${j.id}">Stop</button>`
        : `${j.answer ? `<button type="button" class="link-btn" data-copy="${j.id}">Copy answer</button>` : ''}
           <button type="button" class="link-btn" data-reuse="${j.id}">Edit and resend</button>
           <button type="button" class="link-btn" data-forget="${j.id}">Remove</button>`;
      return `<article class="task ${j.status}" aria-busy="${running}">
        <header><h3>${escapeHtml(j.title || 'New task')}</h3>
          <p class="task-meta"><span class="task-status">${escapeHtml(STATUS[j.status] ?? j.status)}</span>${escapeHtml(who)} · ${escapeHtml(status?.levels?.[j.level]?.name ?? j.level)}${escapeHtml(cost)}</p></header>
        ${conversation(j, running)}
        ${j.error ? `<p class="form-error">${escapeHtml(j.error)}</p>` : ''}
        ${j.note ? `<p class="hint">${escapeHtml(j.note)}</p>` : ''}
        ${!running && j.turns?.length > 1 ? replyBox(j) : ''}
        <div class="form-actions">${actions}</div>
      </article>`;
    }).join('');
    for (const [id, v] of drafts) if ($(id)) $(id).value = v;
    if (focused && $(focused)) $(focused).focus();
  }

  async function reply(id, confirmed = false) {
    const box = $(`reply-${id}`);
    const text = replyPending?.id === id ? replyPending.text : box?.value ?? '';
    const res = await api.reply({ id, text, confirmed });
    replyErrors.delete(id);
    if (res.needsConfirm) {
      replyPending = { id, text, findings: res.findings };
    } else {
      replyPending = undefined;
      if (!res.ok) replyErrors.set(id, res.error);
      else if (box) box.value = '';
    }
    lastJobs = '';
    renderJobs(jobs);
    if (res.needsConfirm) document.querySelector(`[data-reply-anyway="${id}"]`)?.focus();
  }

  $('fd-tasks').addEventListener('submit', (e) => {
    const form = e.target.closest('[data-reply]');
    if (!form) return;
    e.preventDefault();
    reply(form.dataset.reply);
  });
  $('fd-tasks').addEventListener('keydown', (e) => {
    const form = e.target.closest('[data-reply]');
    if (form && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      reply(form.dataset.reply);
    }
  });

  $('fd-tasks').addEventListener('click', async (e) => {
    const t = e.target;
    const job = (attr) => jobs.find((j) => j.id === t.dataset[attr]);
    if (t.dataset.replyAnyway) reply(t.dataset.replyAnyway, true);
    else if (t.dataset.replyEdit) {
      replyPending = undefined;
      lastJobs = '';
      renderJobs(jobs);
      $(`reply-${t.dataset.replyEdit}`)?.focus();
    } else if (t.dataset.stop) api.stop(t.dataset.stop);
    else if (t.dataset.forget) api.forget(t.dataset.forget);
    else if (t.dataset.copy) {
      try {
        await navigator.clipboard.writeText(job('copy')?.answer ?? '');
        t.textContent = 'Copied';
      } catch (err) {
        t.textContent = `Could not copy (${err.name})`;
      }
      setTimeout(() => { t.textContent = 'Copy answer'; }, 2000);
    } else if (t.dataset.reuse) {
      const j = job('reuse');
      if (!$('fd-task') || !j) return;
      $('fd-task').value = j.text;
      level = status?.levels?.[j.level] ? j.level : level;
      skill = j.skill ?? '';
      renderSkills();
      renderLevels();
      $('fd-task').focus();
    }
  });

  // One line for the board header.
  function census(list) {
    const n = list?.length ?? 0;
    if (!n) return 'Front desk open · no tasks yet';
    const busy = list.filter((j) => !['done', 'error', 'stopped'].includes(j.status)).length;
    const tokens = list.reduce((k, j) => k + (j.tokens?.total ?? 0), 0);
    const cost = list.reduce((k, j) => k + (j.cost ?? 0), 0);
    return `${n} task${n === 1 ? '' : 's'}${busy ? ` · ${busy} in progress` : ''} · ${tokens.toLocaleString()} tokens, ${money(cost)} this session`;
  }

  refresh();
  return { refresh, renderJobs, census, team, focusTask: () => $('fd-task')?.focus() };
}
