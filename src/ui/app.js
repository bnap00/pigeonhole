/**
 * The builder.
 *
 * Every edit — in the graph, in the node panel, in the YAML box — writes to
 * one in-memory spec object and re-renders from it, so UI users and git users
 * never diverge. The YAML toggle shows the same object the canvas is editing.
 */
import { renderGraph } from './graph.js';

const state = {
  pipelines: [],
  current: null,      // { pipeline, draft, draft_yaml, lint, versions, test_cases, ... }
  spec: null,         // the live draft being edited
  selectedNode: null,
  tab: 'build',
  status: null,
  lastRun: null,      // probabilities from the last "Try it", shown on option cards
  evalResults: null,
  tryMode: 'form',    // "Try it" input as a generated form, or raw JSON
  tryInput: undefined, // the value both modes edit
  tryFormKey: null,   // the input schema the form was built from
  token: localStorage.getItem('ph_token') || '',
};

// --------------------------------------------------------------- utilities

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  setTimeout(() => el.classList.add('hidden'), 4200);
}

function modal(html) {
  $('#modal-content').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() {
  tokenPromptOpen = false;
  $('#modal').classList.add('hidden');
}
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});

async function api(path, options = {}) {
  // Only declare a JSON body when there is one. Fastify rejects a request that
  // announces `content-type: application/json` and then sends nothing with
  // "Body cannot be empty", so bodyless POSTs and DELETEs — accept a compile,
  // delete a test case, revoke a key — fail with a 400 that looks like the
  // route's own validation rather than a header this helper added.
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers });

  if (res.status === 401) {
    // A token was presented and still bounced: say so, rather than silently
    // showing the same empty prompt again.
    promptForToken(Boolean(state.token));
    throw new Error('unauthorized');
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = body?.detail ?? body?.message ?? `request failed (${res.status})`;
    const hint = body?.hint ? ` — ${body.hint}` : '';
    const err = new Error(detail + hint);
    err.problem = body;
    throw err;
  }
  return body;
}

let tokenPromptOpen = false;

function promptForToken(rejected = false) {
  // Opening a pipeline fans out into several requests at once. Re-rendering the
  // modal for each 401 wipes whatever is half-typed in the field and restores
  // the old value, which is what makes the prompt appear to loop.
  if (tokenPromptOpen) {
    if (rejected) $('#token-error')?.classList.remove('hidden');
    return;
  }
  tokenPromptOpen = true;
  modal(`
    <h3>Admin token required</h3>
    <p class="hint">This stack has PH_ADMIN_TOKEN set. Paste it to use the control plane. It is kept in this browser only.</p>
    <p class="fail ${rejected ? '' : 'hidden'}" id="token-error">
      That token was rejected. Copy the <em>value</em> of PH_ADMIN_TOKEN from your .env —
      <code>grep PH_ADMIN_TOKEN .env | cut -d= -f2-</code>
    </p>
    <input type="text" id="token-input" value="${esc(state.token)}">
    <div class="row"><button class="btn primary" id="token-save">Save</button></div>
  `);
  const input = $('#token-input');
  input.focus();
  input.select();
  input.onkeydown = (e) => {
    if (e.key === 'Enter') $('#token-save').click();
  };
  $('#token-save').onclick = () => {
    state.token = cleanToken(input.value);
    localStorage.setItem('ph_token', state.token);
    tokenPromptOpen = false;
    closeModal();
    void boot();
  };
}

/**
 * Tolerates pasting the whole line out of .env. `PH_ADMIN_TOKEN=abc`, `"abc"`
 * and a stray trailing newline are all the same token, and a stack that
 * rejects the first two teaches nothing useful.
 */
function cleanToken(raw) {
  let token = String(raw ?? '').trim();
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(token);
  if (assignment) token = assignment[1].trim();
  return token.replace(/^["']|["']$/g, '').trim();
}

// ------------------------------------------------------------------- boot

async function boot() {
  try {
    const status = await api('/v1/status');
    state.status = status;
    $('#provider-chip').textContent = `Default: ${modelLabel(status.runtime_model)}`;

    await loadPipelines();
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, 'bad');
  }
}

async function loadPipelines() {
  const { pipelines } = await api('/v1/pipelines');
  state.pipelines = pipelines;
  const list = $('#pipeline-list');
  list.innerHTML = pipelines
    .map(
      (p) => `<li data-id="${esc(p.id)}" class="${state.current?.pipeline.id === p.id ? 'active' : ''}">
        <div class="name">${esc(p.id)}</div>
        <div class="meta">${p.latest_version ? `v${p.latest_version}` : 'draft only'}${p.pinned_version ? ` · pinned v${p.pinned_version}` : ''}</div>
      </li>`,
    )
    .join('');
  list.querySelectorAll('li').forEach((li) => {
    li.onclick = () => openPipeline(li.dataset.id);
  });

  if (!state.current && pipelines.length) await openPipeline(pipelines[0].id);
  if (!pipelines.length) {
    $('#empty').classList.remove('hidden');
    $('#workspace').classList.add('hidden');
  }
}

/** A runtime model with where it runs: `Local · laya`, `OpenRouter · jev-latest`. */
function modelLabel(model) {
  return `${/^(?:convaiinnovations\/)?laya/i.test(model) ? 'Local' : 'OpenRouter'} · ${model}`;
}

async function openPipeline(id) {
  const data = await api(`/v1/pipelines/${encodeURIComponent(id)}`);
  state.current = data;
  state.spec = data.draft ? structuredClone(data.draft) : null;
  state.selectedNode = null;
  state.lastRun = null;
  state.evalResults = null;
  state.tryInput = undefined;
  state.tryFormKey = null;
  $('#tryit-input').value = '';
  $('#tryit-result').classList.add('hidden');
  $('#tryit-status').textContent = '';
  $('#eval-summary').classList.add('hidden');

  $('#empty').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  $('#pipeline-title').textContent = data.pipeline.id;
  $('#pipeline-sub').textContent = `${data.versions.length} version(s)${
    data.pipeline.pinned_version ? ` · pinned to v${data.pipeline.pinned_version}` : ' · following latest'
  }${data.pipeline.runtime_model ? ` · runs on ${modelLabel(data.pipeline.runtime_model)}` : ''}`;
  $('#description').value = data.pipeline.description ?? '';
  $('#link-openapi').href = `/v1/pipelines/${encodeURIComponent(id)}/openapi.json`;

  $$('#pipeline-list li').forEach((li) => li.classList.toggle('active', li.dataset.id === id));

  renderAll();
  renderTargetNotes();
  void loadTab(state.tab);
}

/** Which spec "Try it" and evals run, in words. */
function renderTargetNotes() {
  const w = state.current?.working;
  const text = dirty || w?.source === 'draft'
    ? 'Runs the draft, which has unpublished changes.'
    : w
      ? `Runs v${w.version}, the latest version; the draft matches it.`
      : 'Nothing to run yet: compile or write a spec first.';
  $$('.target-note').forEach((el) => { el.textContent = text; });
}

/** After a save, the draft may now differ from the latest version, or match it again. */
async function refreshWorking() {
  const data = await api(`/v1/pipelines/${encodeURIComponent(state.current.pipeline.id)}`);
  state.current.working = data.working;
  state.current.unpublished_diff = data.unpublished_diff;
  renderTargetNotes();
}

/** "Try it" and evals run the newest spec, so unsaved edits are saved first. */
async function saveIfDirty() {
  if (dirty) await $('#btn-save').onclick();
}

// ----------------------------------------------------------------- render

function renderAll() {
  renderGraphPanel();
  renderNodeEditor();
  renderYaml();
  renderLint();
  renderSettings();
  renderTryForm();
}

function renderGraphPanel() {
  const { layers } = renderGraph($('#graph'), state.spec ?? { nodes: {} }, {
    selected: state.selectedNode,
    onSelect: (id) => {
      state.selectedNode = id;
      renderGraphPanel();
      renderNodeEditor();
    },
  });
  const modelLayers = (layers ?? []).filter((l) =>
    l.some((id) => state.spec?.nodes?.[id]?.type !== 'rule'),
  ).length;
  $('#graph-hint').textContent = state.spec
    ? `${Object.keys(state.spec.nodes).length} nodes · ${modelLayers} model call${modelLayers === 1 ? '' : 's'} per request`
    : '';
}

function renderNodeEditor() {
  const panel = $('#node-editor');
  const id = state.selectedNode;
  if (!id || !state.spec?.nodes?.[id]) {
    $('#node-title').textContent = 'Node';
    panel.innerHTML = '<p class="muted">Select a node in the graph to edit its instructions and options.</p>';
    return;
  }
  const node = state.spec.nodes[id];
  $('#node-title').textContent = `${id} · ${node.type}`;
  const probs = state.lastRun?.nodes?.[id]?.probabilities ?? null;

  let html = '';
  if (node.type !== 'rule') {
    html += `<div class="field">
      <label>Instructions</label>
      <textarea rows="3" data-edit="instructions">${esc(node.instructions ?? '')}</textarea>
    </div>`;
  } else {
    html += `<div class="field">
      <label>Expression</label>
      <textarea rows="3" data-edit="expr">${esc(node.expr ?? '')}</textarea>
    </div>`;
  }

  html += `<div class="field">
    <label>When (optional gate)</label>
    <input type="text" data-edit="when" value="${esc(node.when ?? '')}" placeholder='department == "returns"'>
  </div>`;

  if (node.type === 'choice') {
    html += `<div class="field">
      <label>Min confidence</label>
      <input type="number" step="0.05" min="0" max="1" data-edit="min_confidence" value="${node.min_confidence ?? ''}">
    </div>
    <div class="field">
      <label>On low confidence</label>
      <select data-edit="on_low_confidence">
        <option value="">(flag only)</option>
        ${['human_review', 'error']
          .map((a) => `<option value="${a}" ${node.on_low_confidence === a ? 'selected' : ''}>${a}</option>`)
          .join('')}
        ${Object.keys(node.criteria ?? {})
          .map(
            (o) =>
              `<option value="default:${esc(o)}" ${node.on_low_confidence === `default:${o}` ? 'selected' : ''}>default: ${esc(o)}</option>`,
          )
          .join('')}
      </select>
    </div>`;

    html += '<label>Options</label>';
    for (const [option, criterion] of Object.entries(node.criteria ?? {})) {
      const c = criterion && typeof criterion === 'object' ? criterion : { what: criterion ?? '' };
      const p = probs?.[option];
      html += `<div class="option-card" data-option="${esc(option)}">
        <div class="option-name">
          <span>${esc(option)}</span>
          <button class="btn ghost small" data-remove-option="${esc(option)}">remove</button>
        </div>
        <textarea rows="2" data-criterion="what" placeholder="what belongs here">${esc(c.what ?? '')}</textarea>
        <textarea rows="2" data-criterion="not_for" placeholder="not for… (name the option it belongs in)">${esc(c.not_for ?? '')}</textarea>
        <textarea rows="2" data-criterion="examples" placeholder="examples, one per line">${esc((c.examples ?? []).join('\n'))}</textarea>
        ${p !== undefined ? `<div class="prob-bar" title="${(p * 100).toFixed(1)}% on the last run"><span style="width:${(p * 100).toFixed(1)}%"></span></div>` : ''}
      </div>`;
    }
    html += `<div class="row">
      <input type="text" id="new-option" placeholder="new option name" style="flex:1">
      <button class="btn small" id="btn-add-option">Add</button>
    </div>
    <div class="row"><button class="btn ghost small" id="btn-ai-assist">Ask the compiler to fix this node</button></div>`;
  }

  if (node.type === 'score') {
    html += `<div class="row">
      <div class="field" style="flex:1"><label>Min</label><input type="number" data-edit="scale.min" value="${node.scale?.min ?? 0}"></div>
      <div class="field" style="flex:1"><label>Max</label><input type="number" data-edit="scale.max" value="${node.scale?.max ?? 2}"></div>
    </div>`;
  }

  html += `<div class="row"><button class="btn ghost small danger" id="btn-remove-node">Delete node</button></div>`;
  panel.innerHTML = html;

  // Wire edits straight back into the spec object.
  panel.querySelectorAll('[data-edit]').forEach((el) => {
    el.onchange = () => {
      const field = el.dataset.edit;
      let value = el.value;
      if (field === 'min_confidence') value = value === '' ? undefined : Number(value);
      if (field.startsWith('scale.')) {
        node.scale ??= { min: 0, max: 2 };
        node.scale[field.split('.')[1]] = Number(value);
        markDirty();
        return;
      }
      if (value === '' || value === undefined) delete node[field];
      else node[field] = value;
      markDirty();
    };
  });

  panel.querySelectorAll('.option-card').forEach((card) => {
    const option = card.dataset.option;
    card.querySelectorAll('[data-criterion]').forEach((el) => {
      el.onchange = () => {
        const current = node.criteria[option];
        const c = current && typeof current === 'object' ? { ...current } : {};
        const field = el.dataset.criterion;
        if (field === 'examples') {
          const lines = el.value.split('\n').map((l) => l.trim()).filter(Boolean);
          if (lines.length) c.examples = lines;
          else delete c.examples;
        } else if (el.value.trim()) {
          c[field] = el.value.trim();
        } else {
          delete c[field];
        }
        node.criteria[option] = Object.keys(c).length ? c : null;
        markDirty();
      };
    });
    card.querySelector('[data-remove-option]').onclick = () => {
      delete node.criteria[option];
      renderAll();
      markDirty();
    };
  });

  const addOption = $('#btn-add-option');
  if (addOption) {
    addOption.onclick = () => {
      const name = $('#new-option').value.trim();
      if (!name) return;
      node.criteria[name] = null;
      renderAll();
      markDirty();
    };
  }

  const aiAssist = $('#btn-ai-assist');
  if (aiAssist) aiAssist.onclick = () => askCompiler(id);

  $('#btn-remove-node').onclick = () => {
    delete state.spec.nodes[id];
    state.selectedNode = null;
    renderAll();
    markDirty();
  };
}

function renderYaml() {
  if (!state.spec) {
    $('#yaml').value = '';
    return;
  }
  // Rendered server-side on load; locally we keep the textarea in sync only
  // when the user is not editing it.
  if (document.activeElement !== $('#yaml')) {
    $('#yaml').value = state.current?.draft_yaml ?? '';
  }
}

function renderLint() {
  const warnings = state.current?.lint ?? [];
  const panel = $('#lint-panel');
  if (!warnings.length) {
    panel.innerHTML = '<h3>Lint</h3><p class="hint">No warnings.</p>';
    return;
  }
  panel.innerHTML = `<h3>Lint · ${warnings.length}</h3>
    <ul class="warning-list">${warnings
      .map(
        (w) =>
          `<li><span class="code">${esc(w.code)}</span>${w.node ? `<strong>${esc(w.node)}</strong> · ` : ''}${esc(w.message)}</li>`,
      )
      .join('')}</ul>`;
}

function renderSettings() {
  const compose = state.spec?.compose ?? {};
  const form = $('#settings-form');
  const field = (label, html) => `<label>${esc(label)}</label><div>${html}</div>`;
  const select = (path, value, options) =>
    `<select data-setting="${path}">${options
      .map((o) => `<option value="${o}" ${value === o ? 'selected' : ''}>${o}</option>`)
      .join('')}</select>`;

  form.innerHTML =
    field('Answer cache', select('cache.mode', compose.cache?.mode ?? 'off', ['off', 'memory'])) +
    field('Cache TTL (seconds)', `<input type="number" data-setting="cache.ttl" value="${compose.cache?.ttl ?? 300}">`) +
    field('Telemetry', select('logging.telemetry', compose.logging?.telemetry ?? 'postgres', ['postgres', 'none'])) +
    field('Retain run payloads', select('logging.retain', compose.logging?.retain ?? 'low_confidence', ['all', 'sampled', 'low_confidence', 'none'])) +
    field('Sample rate', `<input type="number" step="0.01" min="0" max="1" data-setting="logging.sample_rate" value="${compose.logging?.sample_rate ?? 0.01}">`) +
    field('Retention (days)', `<input type="number" data-setting="logging.retention_days" value="${compose.logging?.retention_days ?? 90}">`) +
    field('Input logging', select('logging.input', compose.logging?.input ?? 'full', ['full', 'hash_only', 'off'])) +
    field('Redact PII before logging', `<input type="checkbox" data-setting="logging.redact_pii" ${compose.logging?.redact_pii ? 'checked' : ''}>`) +
    field('Archive eval reports', `<input type="checkbox" data-setting="archive.reports" ${compose.archive?.reports !== false ? 'checked' : ''}>`);

  form.querySelectorAll('[data-setting]').forEach((el) => {
    el.onchange = () => {
      if (!state.spec) return;
      const [group, key] = el.dataset.setting.split('.');
      state.spec.compose ??= {};
      state.spec.compose[group] ??= {};
      const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
      state.spec.compose[group][key] = value;
      markDirty();
    };
  });
}

let dirty = false;
function markDirty() {
  dirty = true;
  $('#btn-save').textContent = 'Save draft •';
  renderTargetNotes();
}

// ------------------------------------------------------------ save/publish

$('#btn-save').onclick = async () => {
  if (!state.spec) return toast('Nothing to save yet', 'bad');
  try {
    state.spec.description = $('#description').value;
    const res = await api(`/v1/pipelines/${state.current.pipeline.id}`, {
      method: 'PUT',
      body: JSON.stringify({ spec: state.spec }),
    });
    state.current.lint = res.lint;
    state.current.draft_yaml = res.draft_yaml;
    dirty = false;
    $('#btn-save').textContent = 'Save draft';
    renderAll();
    await refreshWorking();
    toast('Draft saved', 'ok');
  } catch (err) {
    toast(err.message, 'bad');
  }
};

$('#btn-publish').onclick = async () => {
  if (!state.spec) return;
  if (dirty) {
    await $('#btn-save').onclick();
  }
  try {
    const res = await api(`/v1/pipelines/${state.current.pipeline.id}/versions`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    toast(`Published version ${res.version}. Every runtime replica saw it immediately.`, 'ok');
    await openPipeline(state.current.pipeline.id);
    await loadPipelines();
  } catch (err) {
    toast(err.message, 'bad');
  }
};

$('#btn-apply-yaml').onclick = async () => {
  try {
    const res = await api(`/v1/pipelines/${state.current.pipeline.id}`, {
      method: 'PUT',
      body: JSON.stringify({ spec_yaml: $('#yaml').value }),
    });
    state.current.lint = res.lint;
    state.current.draft_yaml = res.draft_yaml;
    state.spec = structuredClone(res.pipeline.draft_spec);
    $('#yaml-status').textContent = 'Applied.';
    renderAll();
    await refreshWorking();
    toast('YAML applied', 'ok');
  } catch (err) {
    $('#yaml-status').textContent = err.message;
    toast(err.message, 'bad');
  }
};

$('#btn-toggle-yaml').onclick = () => {
  const panel = $('#yaml-panel');
  panel.classList.toggle('hidden');
  $('#btn-toggle-yaml').textContent = panel.classList.contains('hidden') ? 'Show YAML' : 'Hide YAML';
  renderYaml();
};

// ---------------------------------------------------------------- compile

$('#btn-compile').onclick = () => startCompile({ description: $('#description').value });

function askCompiler(nodeId) {
  modal(`
    <h3>Ask the compiler</h3>
    <p class="hint">An incremental edit. Only the nodes you name are touched, and you review a diff before anything is saved.</p>
    <textarea id="assist-instruction" rows="3" placeholder='e.g. "add an option for warranty claims to ${esc(nodeId)}"'></textarea>
    <div class="row"><button class="btn primary" id="assist-go">Compile edit</button></div>
  `);
  $('#assist-go').onclick = () => {
    const instruction = $('#assist-instruction').value.trim();
    if (!instruction) return;
    closeModal();
    startCompile({ instruction });
  };
}

async function startCompile(body) {
  const progress = $('#compile-progress');
  const diffBox = $('#compile-diff');
  diffBox.classList.add('hidden');
  progress.classList.remove('hidden');
  progress.innerHTML = 'Queueing…';
  $('#btn-compile').disabled = true;

  try {
    const started = await api(`/v1/pipelines/${state.current.pipeline.id}/compile`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    progress.innerHTML = `Estimated cost $${(started.cost_estimate_usd ?? 0).toFixed(3)} · queued`;

    // Pass-level progress over SSE, published by the worker to the bus. The
    // compile is a job and its row is the truth, so the stream is only ever a
    // nicety: if it never opens or drops halfway, we poll instead. Losing the
    // stream must never leave the page sitting on "queued" forever.
    let settled = false;
    const events = new EventSource(started.events_url);
    events.addEventListener('progress', (e) => {
      const p = JSON.parse(e.data);
      const pct = p.of ? Math.round(((p.index ?? 0) / p.of) * 100) : 0;
      progress.innerHTML = `<strong>${esc(p.pass ?? 'working')}</strong> — ${esc(p.message ?? '')}
        <div class="bar"><span style="width:${pct}%"></span></div>`;
    });
    events.addEventListener('done', () => {
      events.close();
      if (settled) return;
      settled = true;
      finishCompile(started.compile_id, progress);
    });
    events.onerror = () => {
      events.close();
      if (settled) return;
      settled = true;
      pollCompile(started.compile_id, progress);
    };
  } catch (err) {
    progress.innerHTML = `<span class="fail">${esc(err.message)}</span>`;
    $('#btn-compile').disabled = false;
  }
}

/** Reads the finished row and renders its diff. Shared by the stream and the poller. */
async function finishCompile(compileId, progress) {
  $('#btn-compile').disabled = false;
  try {
    const finished = await api(`/v1/pipelines/${state.current.pipeline.id}/compile/${compileId}`);
    if (finished.status === 'failed') {
      progress.innerHTML = `<span class="fail">Compile failed: ${esc(finished.error ?? 'unknown error')}</span>`;
      return;
    }
    progress.innerHTML = `Done. Actual cost $${(finished.actual_cost_usd ?? 0).toFixed(3)}.`;
    showDiff(compileId, finished);
  } catch (err) {
    progress.innerHTML = `<span class="fail">${esc(err.message)}</span>`;
  }
}

/** The fallback when the progress stream is unavailable. A compile is a job; the row is the truth. */
async function pollCompile(compileId, progress) {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    let row;
    try {
      row = await api(`/v1/pipelines/${state.current.pipeline.id}/compile/${compileId}`);
    } catch (err) {
      progress.innerHTML = `<span class="fail">${esc(err.message)}</span>`;
      $('#btn-compile').disabled = false;
      return;
    }
    if (row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') {
      return finishCompile(compileId, progress);
    }
    const p = row.progress ?? {};
    const pct = p.of ? Math.round(((p.index ?? 0) / p.of) * 100) : 0;
    progress.innerHTML = `<strong>${esc(p.pass ?? row.status)}</strong> — ${esc(p.message ?? 'working')}
      <div class="bar"><span style="width:${pct}%"></span></div>
      <span class="hint">live updates unavailable, polling instead</span>`;
  }
  $('#btn-compile').disabled = false;
  progress.innerHTML = `<span class="fail">Lost track of this compile. It may still be running — reopen the pipeline to check.</span>`;
}

function showDiff(compileId, finished) {
  const d = finished.diff ?? {};
  const box = $('#compile-diff');
  const list = [];
  if (d.nodes?.added?.length) list.push(`Added nodes: ${d.nodes.added.join(', ')}`);
  if (d.nodes?.removed?.length) list.push(`Removed nodes: ${d.nodes.removed.join(', ')}`);
  for (const c of d.nodes?.changed ?? []) {
    const bits = [];
    if (c.options_added.length) bits.push(`+${c.options_added.join(', +')}`);
    if (c.options_removed.length) bits.push(`-${c.options_removed.join(', -')}`);
    list.push(`Changed ${c.id}${bits.length ? ` (${bits.join(' ')})` : ''}: ${c.fields.join(', ')}`);
  }
  if (d.tests) list.push(`Tests: ${d.tests.before} → ${d.tests.after}`);

  box.innerHTML = `<strong>${esc(d.summary ?? 'Proposed changes')}</strong>
    <ul>${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <div class="row">
      <button class="btn primary" id="btn-accept">Accept as draft</button>
      <button class="btn ghost" id="btn-discard">Discard</button>
    </div>
    <p class="hint">Nothing goes live until you publish.</p>`;
  box.classList.remove('hidden');

  $('#btn-accept').onclick = async () => {
    // Without this the failure is an unhandled rejection: the diff stays open,
    // no toast appears, and the button reads as doing nothing at all.
    try {
      await api(`/v1/pipelines/${state.current.pipeline.id}/compile/${compileId}/accept`, { method: 'POST' });
    } catch (err) {
      return toast(err.message, 'bad');
    }
    box.classList.add('hidden');
    await openPipeline(state.current.pipeline.id);
    toast('Compiler result is now your draft', 'ok');
  };
  $('#btn-discard').onclick = () => box.classList.add('hidden');
}

// ----------------------------------------------------------------- try it

/*
 * "Try it" takes input as a form generated from the spec's input schema, or as
 * raw JSON. Both edit `state.tryInput`, so switching keeps what was typed.
 */

const LONG_TEXT = /body|description|text|content|message|comment|note|detail|summary|transcript/i;

function inputSchema() {
  return state.spec?.input ?? state.current?.draft?.input ?? null;
}

/** One field per property of an object schema, or null to take the input as one text. */
function formFields(schema) {
  if (!schema || schema.type !== 'object' || !schema.properties) return null;
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, raw]) => {
    const s = raw ?? {};
    const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
    const kind = Array.isArray(s.enum)
      ? 'enum'
      : type === 'boolean'
        ? 'boolean'
        : type === 'number' || type === 'integer'
          ? 'number'
          : type === 'array' && (s.items?.type === 'string' || !s.items)
            ? 'lines'
            : type === 'string' || type === undefined
              ? (LONG_TEXT.test(name) || (s.maxLength ?? 0) > 200 ? 'text' : 'line')
              : 'json';
    return { name, schema: s, kind, type: type ?? 'string', required: required.has(name) };
  });
}

/** An example input, for placeholders: the first test case's. */
function exampleInput() {
  return state.current?.test_cases?.[0]?.input ?? state.spec?.tests?.[0]?.input;
}

function renderTryForm() {
  if (!state.current) return;
  const schema = inputSchema();
  const key = JSON.stringify(schema ?? null);
  if (key === state.tryFormKey) return; // unchanged: keep what is typed
  if (state.tryFormKey !== null && state.tryMode === 'form') {
    try { state.tryInput = readTryForm(); } catch { /* keep the last good value */ }
  }
  state.tryFormKey = key;

  const fields = formFields(schema);
  const example = exampleInput();
  const placeholder = (name) => {
    const v = fields ? example?.[name] : example;
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  const control = (f) => {
    const id = `tf-${f.name}`;
    const ph = esc(placeholder(f.name));
    if (f.kind === 'enum') {
      return `<select id="${id}" data-field="${esc(f.name)}">
        ${f.required ? '' : '<option value="">—</option>'}
        ${f.schema.enum.map((v) => `<option value="${esc(JSON.stringify(v))}">${esc(v)}</option>`).join('')}
      </select>`;
    }
    if (f.kind === 'boolean') return `<label class="check"><input type="checkbox" id="${id}" data-field="${esc(f.name)}"> true</label>`;
    if (f.kind === 'number') {
      return `<input type="number" id="${id}" data-field="${esc(f.name)}" placeholder="${ph}"
        ${f.schema.minimum !== undefined ? `min="${f.schema.minimum}"` : ''} ${f.schema.maximum !== undefined ? `max="${f.schema.maximum}"` : ''}
        ${f.type === 'integer' ? 'step="1"' : 'step="any"'}>`;
    }
    if (f.kind === 'line') return `<input type="text" id="${id}" data-field="${esc(f.name)}" placeholder="${ph}">`;
    const rows = f.kind === 'text' ? 4 : 3;
    const hint = f.kind === 'lines' ? 'one per line' : f.kind === 'json' ? 'JSON' : '';
    return `<textarea id="${id}" data-field="${esc(f.name)}" rows="${rows}" placeholder="${ph}"
      class="${f.kind === 'json' ? 'mono' : ''}" title="${hint}"></textarea>`;
  };

  $('#tryit-form').innerHTML = fields
    ? fields.length
      ? fields.map((f) => `<div class="input-field">
          <label for="tf-${esc(f.name)}">${esc(f.name)}${f.required ? ' <span class="req">*</span>' : ''}
            <span class="type">${esc(f.kind === 'lines' ? 'list of strings' : f.kind === 'enum' ? 'one of' : f.type)}</span></label>
          ${control(f)}
          ${f.schema.description ? `<div class="hint">${esc(f.schema.description)}</div>` : ''}
        </div>`).join('')
      : '<p class="hint">The input schema has no properties; use JSON.</p>'
    : `<div class="input-field"><label for="tf-__text">input <span class="type">text</span></label>
        <textarea id="tf-__text" data-field="__text" rows="4" placeholder="${esc(placeholder())}"></textarea></div>`;

  // A JSON-only schema has nothing to build a form from.
  if (fields && !fields.length) setTryMode('json');
  writeTryForm(state.tryInput);
  $('#tryit-input').placeholder = example !== undefined ? JSON.stringify(example, null, 2) : '{ }';
}

/** The form's value, as the pipeline input. Throws, naming the field, on bad JSON. */
function readTryForm() {
  const fields = formFields(inputSchema());
  if (!fields) return $('#tf-__text')?.value ?? '';
  const out = {};
  for (const f of fields) {
    const el = document.getElementById(`tf-${f.name}`);
    if (!el) continue;
    if (f.kind === 'boolean') {
      if (el.checked || f.required) out[f.name] = el.checked;
      continue;
    }
    const raw = el.value;
    if (raw === '' && !f.required) continue;
    if (f.kind === 'enum') out[f.name] = raw === '' ? undefined : JSON.parse(raw);
    else if (f.kind === 'number') out[f.name] = raw === '' ? undefined : Number(raw);
    else if (f.kind === 'lines') out[f.name] = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    else if (f.kind === 'json') {
      try { out[f.name] = JSON.parse(raw); } catch { throw new Error(`${f.name} is not valid JSON`); }
    } else out[f.name] = raw;
  }
  return out;
}

function writeTryForm(value) {
  const fields = formFields(inputSchema());
  if (!fields) {
    const el = $('#tf-__text');
    if (el) el.value = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
    return;
  }
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  for (const f of fields) {
    const el = document.getElementById(`tf-${f.name}`);
    if (!el) continue;
    const v = obj[f.name];
    if (f.kind === 'boolean') el.checked = v === true;
    else if (f.kind === 'enum') el.value = v === undefined ? (f.required ? el.options[0]?.value ?? '' : '') : JSON.stringify(v);
    else if (f.kind === 'lines') el.value = Array.isArray(v) ? v.join('\n') : '';
    else if (f.kind === 'json') el.value = v === undefined ? '' : JSON.stringify(v, null, 2);
    else el.value = v === undefined ? '' : String(v);
  }
}

/** The value in the JSON box. Plain text is accepted when the input is a string. */
function readTryJson() {
  const raw = $('#tryit-input').value.trim();
  if (!raw) return formFields(inputSchema()) ? {} : '';
  try {
    return JSON.parse(raw);
  } catch {
    if (!formFields(inputSchema())) return raw;
    throw new Error('That is not valid JSON');
  }
}

function setTryMode(mode) {
  if (mode === state.tryMode) return;
  try {
    state.tryInput = state.tryMode === 'form' ? readTryForm() : readTryJson();
  } catch (err) {
    return toast(err.message, 'bad');
  }
  state.tryMode = mode;
  if (mode === 'json') {
    $('#tryit-input').value = state.tryInput === undefined || state.tryInput === '' ? '' : JSON.stringify(state.tryInput, null, 2);
  } else {
    writeTryForm(state.tryInput);
  }
  $('#tryit-form').classList.toggle('hidden', mode !== 'form');
  $('#tryit-input').classList.toggle('hidden', mode !== 'json');
  $$('#tryit-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
}

$('#tryit-mode').onclick = (e) => {
  const button = e.target.closest('button');
  if (button) setTryMode(button.dataset.mode);
};

$('#btn-tryit').onclick = async () => {
  let input;
  try {
    input = state.tryMode === 'form' ? readTryForm() : readTryJson();
  } catch (err) {
    return toast(err.message, 'bad');
  }
  state.tryInput = input;
  $('#tryit-status').textContent = 'Classifying…';
  try {
    await saveIfDirty();
    const result = await api(`/v1/pipelines/${encodeURIComponent(state.current.pipeline.id)}/try`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    });
    state.lastRun = result;
    $('#tryit-status').textContent =
      `${result.target === 'draft' ? 'draft' : result.target} · ${result.latency_ms}ms · ` +
      `${result.usage.decision_calls} call(s) · ${result.model}`;
    $('#tryit-result').classList.remove('hidden');
    $('#tryit-result').innerHTML = `
      <div class="detail-grid">
        <div><div class="label">Output</div><pre>${esc(JSON.stringify(result.output, null, 2))}</pre></div>
        <div><div class="label">Node answers</div>${renderNodeAnswers(result.nodes)}</div>
      </div>
      <details><summary class="hint">Full response</summary>
        <pre>${esc(JSON.stringify(result, null, 2))}</pre>
      </details>`;
    // Probability bars on the option cards come from this run.
    renderNodeEditor();
  } catch (err) {
    $('#tryit-status').textContent = '';
    $('#tryit-result').classList.remove('hidden');
    $('#tryit-result').innerHTML = `<pre class="fail">${esc(err.message)}</pre>`;
  }
};

/**
 * Each node's answer in one compact row: what it said, how sure, and the
 * distribution behind it. Everything is in the title for the full numbers.
 */
function renderNodeAnswers(nodes) {
  const entries = Object.entries(nodes ?? {});
  if (!entries.length) return '<p class="hint">No node answers.</p>';
  const fmt = (n) => (typeof n === 'number' ? (Math.round(n * 1000) / 1000).toString() : '—');
  const rows = entries.map(([id, n]) => {
    let answer;
    if (n.error) answer = `<span class="fail">${esc(n.error)}</span>`;
    else if (n.type === 'choice') answer = esc(n.choice ?? '—') + (n.also?.length ? ` <span class="hint">+ ${esc(n.also.join(', '))}</span>` : '');
    else if (n.type === 'noul') answer = `p(yes) ${fmt(n.p)}`;
    else if (n.type === 'score') answer = esc(n.score ?? '—');
    else answer = `<span class="mono">${esc(JSON.stringify(n.value))}</span>`;
    const tags = [
      n.skipped ? '<span class="tag">gate closed</span>' : '',
      n.low_confidence ? '<span class="tag warn">low confidence</span>' : '',
      n.action ? `<span class="tag">${esc(n.action)}</span>` : '',
    ].join('');
    const probs = Object.entries(n.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
    const dist = probs.length
      ? `<div class="dist" title="${esc(probs.map(([k, v]) => `${k}: ${v}`).join('\n'))}">${probs
          .slice(0, 4)
          .map(([k, v]) => `<span><i style="width:${Math.max(2, Math.round(v * 40))}px"></i>${esc(k)} ${fmt(v)}</span>`)
          .join('')}${probs.length > 4 ? `<span class="hint">+${probs.length - 4}</span>` : ''}</div>`
      : '';
    return `<tr${n.skipped ? ' class="skipped"' : ''}>
      <td class="mono">${esc(id)}</td>
      <td>${answer} ${tags}</td>
      <td>${fmt(n.confidence)}</td>
      <td>${dist}</td>
    </tr>`;
  });
  return `<table class="table compact"><thead><tr><th>Node</th><th>Answer</th><th>Conf.</th><th>Distribution</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;
}

/** Rows that open a detail row beneath them. Clicks on buttons inside a row do not. */
function expandable(tbody) {
  tbody.onclick = (e) => {
    if (e.target.closest('button, a, input')) return;
    const row = e.target.closest('tr.expandable');
    if (!row) return;
    row.classList.toggle('open');
    row.nextElementSibling?.classList.toggle('hidden');
  };
}

// ------------------------------------------------------------------ evals

/**
 * A case that threw never reached a model, so it is not a wrong answer — it is
 * a case that could not run, and accuracy is measured without it. When none
 * ran there is no accuracy at all, and the panel says why, by cause: a
 * provider that cannot answer and a test suite the schema rejects call for
 * completely different fixes.
 */
const EVAL_ERROR_HINTS = {
  provider_error:
    'The model provider (OpenRouter, or your Laya server) could not answer; <code>make logs</code> shows why. ' +
    'Nothing here reflects on the pipeline. See docs/troubleshooting.md.',
  input_invalid:
    'These test inputs do not satisfy the pipeline\'s input schema, so they are rejected ' +
    'before any model is called. If they were generated against an older schema, ' +
    'recompile to regenerate them.',
};

function renderEvalErrors(res) {
  const errors = res.errors ?? [];
  if (!errors.length) return '';
  // `errors` is a truncated sample; `errored` is the real count.
  const errored = res.errored ?? errors.length;
  const noneRan = res.accuracy === null || res.accuracy === undefined;
  const hints = Object.keys(res.error_kinds ?? {})
    .map((kind) => EVAL_ERROR_HINTS[kind])
    .filter(Boolean);
  return `
    <p class="fail">${errored} of ${res.cases} cases could not run${
      noneRan
        ? ' — none reached the model, so there is no accuracy to report'
        : `, so accuracy is measured on the other ${res.cases - errored}`
    }.</p>
    <ul class="hint">${errors
      .slice(0, 5)
      .map((e) => `<li>${esc(e)}</li>`)
      .join('')}</ul>
    ${hints.map((h) => `<p class="hint">${h}</p>`).join('')}`;
}

$('#btn-eval').onclick = async () => {
  $('#eval-summary').classList.remove('hidden');
  $('#eval-summary').innerHTML = '<p class="hint">Running…</p>';
  try {
    await saveIfDirty();
    const res = await api(`/v1/pipelines/${encodeURIComponent(state.current.pipeline.id)}/evals?wait=true`, {
      method: 'POST',
      body: JSON.stringify({ target: 'working' }),
    });
    if (res.status === 'queued') {
      $('#eval-summary').innerHTML = `<p class="hint">${res.cases} cases is too many to run inline; the eval is queued. Its result appears under Versions.</p>`;
      return;
    }
    state.evalResults = res;
    // No accuracy when no case reached the model: a dash, never a 0%.
    const pct = res.accuracy === null ? '—' : `${(res.accuracy * 100).toFixed(1)}%`;
    const calib = (res.calibration ?? []).find((c) => c.threshold === 0.8);
    $('#eval-summary').innerHTML = `
      <div class="stat-row">
        <div class="stat"><div class="label">Accuracy</div><div class="value">${pct}</div></div>
        <div class="stat"><div class="label">Passed</div><div class="value">${res.passed}/${res.cases}</div></div>
        <div class="stat"><div class="label">Ran on</div><div class="value" style="font-size:14px">${
          res.target === 'draft' ? 'the draft <span class="hint">(not stored)</span>' : esc(res.target ?? '')
        }</div></div>
        <div class="stat"><div class="label">Model</div><div class="value" style="font-size:14px">${esc(res.resolved_model)}</div></div>
        ${calib && calib.n ? `<div class="stat"><div class="label">Correct at conf ≥ 0.8</div><div class="value">${(calib.rate * 100).toFixed(0)}%</div></div>` : ''}
      </div>
      ${
        res.top_confusions?.length
          ? `<p class="hint">Top confusions: ${res.top_confusions
              .map((c) => `${esc(c.node)}: ${esc(c.expected)} → ${esc(c.actual)} (${c.count}×)`)
              .join(' · ')}</p>`
          : ''
      }
      ${renderEvalErrors(res)}`;
    renderTests();
  } catch (err) {
    $('#eval-summary').innerHTML = `<p class="fail">${esc(err.message)}</p>`;
  }
};

/**
 * The test cases, with the last eval's answer beside each. Rows stay one line;
 * clicking one opens the full input, expectation, output and node answers.
 */
function renderTests() {
  const tests = state.current?.test_cases ?? [];
  const res = state.evalResults;
  // Older responses carry failures only; a case missing from them passed.
  const results = res?.results ?? null;
  const unused = new Set(results ? results.keys() : []);
  const resultFor = (t) => {
    if (!res) return null;
    const key = JSON.stringify(t.input);
    if (results) {
      for (const i of unused) {
        if (results[i] && JSON.stringify(results[i].input) === key) {
          unused.delete(i);
          return results[i];
        }
      }
      return null;
    }
    const failure = (res.failures ?? []).find((f) => JSON.stringify(f.input) === key);
    return failure ? { ...failure, passed: false } : { passed: true };
  };

  const tbody = $('#tests-table tbody');
  tbody.innerHTML = tests.length
    ? tests
        .map((t) => {
          const r = resultFor(t);
          const actual = !r
            ? '<td class="hint">—</td>'
            : r.error
              ? `<td class="truncate fail">error: ${esc(r.error)}</td>`
              : r.passed
                ? `<td class="truncate pass">✓ <span class="hint">${esc(r.actual ? JSON.stringify(r.actual) : '')}</span></td>`
                : `<td class="truncate fail">${esc(JSON.stringify(r.actual))}</td>`;
          return `<tr class="expandable">
            <td>${esc(t.name ?? '')}<div class="hint">${esc(t.source)}</div></td>
            <td class="truncate">${esc(JSON.stringify(t.input))}</td>
            <td class="truncate">${esc(JSON.stringify(t.expected))}</td>
            ${actual}
            <td><button class="btn ghost small" data-del-test="${t.id}">×</button></td>
          </tr>
          <tr class="detail hidden"><td colspan="5">
            <div class="detail-grid three">
              <div><div class="label">Input</div><pre>${esc(JSON.stringify(t.input, null, 2))}</pre></div>
              <div><div class="label">Expected</div><pre>${esc(JSON.stringify(t.expected, null, 2))}</pre></div>
              <div><div class="label">Actual</div>${
                !r
                  ? '<p class="hint">Run the eval to see what the model answers.</p>'
                  : r.error
                    ? `<pre class="fail">${esc(r.error)}</pre>`
                    : r.actual
                      ? `<pre class="${r.passed ? '' : 'fail'}">${esc(JSON.stringify(r.actual, null, 2))}</pre>`
                      : '<p class="hint">Passed.</p>'
              }</div>
            </div>
            ${r?.nodes ? `<div class="label">Node answers</div>${renderNodeAnswers(r.nodes)}` : ''}
          </td></tr>`;
        })
        .join('')
    : '<tr><td colspan="5" class="hint">No test cases. Compile generates them, or add one by hand.</td></tr>';
  expandable(tbody);

  $$('[data-del-test]').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/v1/pipelines/${state.current.pipeline.id}/tests/${btn.dataset.delTest}`, { method: 'DELETE' });
      await openPipeline(state.current.pipeline.id);
    };
  });
}

$('#btn-add-test').onclick = () => {
  modal(`
    <h3>Add a test case</h3>
    <div class="field"><label>Input (JSON)</label><textarea id="tc-input" rows="4">{ "body": "" }</textarea></div>
    <div class="field"><label>Expected output (JSON)</label><textarea id="tc-expect" rows="3">{ }</textarea></div>
    <div class="row"><button class="btn primary" id="tc-save">Add</button></div>
  `);
  $('#tc-save').onclick = async () => {
    try {
      await api(`/v1/pipelines/${state.current.pipeline.id}/tests`, {
        method: 'POST',
        body: JSON.stringify({
          input: JSON.parse($('#tc-input').value),
          expect: JSON.parse($('#tc-expect').value),
        }),
      });
      closeModal();
      await openPipeline(state.current.pipeline.id);
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
};

// ------------------------------------------------------------------- runs

async function loadRuns() {
  const params = new URLSearchParams({ limit: '50' });
  if ($('#runs-lowconf').checked) params.set('low_confidence', 'true');
  if ($('#runs-review').checked) params.set('needs_review', 'true');
  const { runs, note } = await api(`/v1/pipelines/${state.current.pipeline.id}/runs?${params}`);
  $('#runs-hint').textContent = note ?? `${runs.length} retained run(s)`;

  $('#runs-table tbody').innerHTML = runs.length
    ? runs
        .map((r) => {
          const conf = Object.values(r.node_answers ?? {})
            .map((n) => n.confidence)
            .filter((c) => typeof c === 'number');
          const min = conf.length ? Math.min(...conf) : null;
          return `<tr class="expandable">
            <td class="hint">${new Date(r.created_at).toLocaleString()}</td>
            <td class="truncate">${esc(JSON.stringify(r.input ?? '(not retained)'))}</td>
            <td class="truncate">${esc(JSON.stringify(r.output))}</td>
            <td class="${r.low_confidence ? 'fail' : ''}">${min === null ? '—' : min.toFixed(2)}</td>
            <td>${r.latency_ms}ms</td>
            <td><button class="btn ghost small" data-correct="${esc(r.id)}">Correct</button></td>
          </tr>
          <tr class="detail hidden"><td colspan="6">
            <div class="detail-grid">
              <div><div class="label">Input</div><pre>${esc(JSON.stringify(r.input ?? '(not retained)', null, 2))}</pre></div>
              <div><div class="label">Output</div><pre>${esc(JSON.stringify(r.output, null, 2))}</pre></div>
            </div>
            <div class="label">Node answers</div>${renderNodeAnswers(r.node_answers)}
            <p class="hint mono">${esc(r.id)} · v${esc(r.version ?? '?')} · ${esc(r.model ?? '')}</p>
          </td></tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="hint">No retained runs. Retention is per pipeline in Settings.</td></tr>';
  expandable($('#runs-table tbody'));

  $$('[data-correct]').forEach((btn) => {
    btn.onclick = () => correctRun(btn.dataset.correct, runs.find((r) => r.id === btn.dataset.correct));
  });
}

function correctRun(runId, run) {
  modal(`
    <h3>Correct this run</h3>
    <p class="hint">The correction is stored as feedback, and can be promoted to a test case in one step.</p>
    <div class="field"><label>Input</label><pre>${esc(JSON.stringify(run?.input, null, 2))}</pre></div>
    <div class="field"><label>Model said</label><pre>${esc(JSON.stringify(run?.output, null, 2))}</pre></div>
    <div class="field"><label>Correct output (JSON)</label>
      <textarea id="fb-correct" rows="4">${esc(JSON.stringify(run?.output ?? {}, null, 2))}</textarea></div>
    <label class="check"><input type="checkbox" id="fb-promote" checked> Promote to a test case</label>
    <div class="row"><button class="btn primary" id="fb-save">Save correction</button></div>
  `);
  $('#fb-save').onclick = async () => {
    try {
      await api(`/v1/runs/${runId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({
          correct_output: JSON.parse($('#fb-correct').value),
          is_correct: false,
          promote_to_test: $('#fb-promote').checked,
        }),
      });
      closeModal();
      toast('Correction saved', 'ok');
      await loadRuns();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
}

$('#btn-refresh-runs').onclick = () => void loadRuns();
$('#runs-lowconf').onchange = () => void loadRuns();
$('#runs-review').onchange = () => void loadRuns();

// -------------------------------------------------------------- analytics

async function loadAnalytics() {
  const data = await api(`/v1/pipelines/${state.current.pipeline.id}/analytics?days=30`);
  const o = data.overview;
  $('#stat-row').innerHTML = `
    <div class="stat"><div class="label">Runs (30d)</div><div class="value">${o.runs.toLocaleString()}</div></div>
    <div class="stat"><div class="label">Low confidence</div><div class="value">${(o.low_confidence_rate * 100).toFixed(1)}%</div></div>
    <div class="stat"><div class="label">Avg latency</div><div class="value">${o.avg_latency_ms}ms</div></div>
    <div class="stat"><div class="label">p95 latency</div><div class="value">${o.p95_latency_ms}ms</div></div>
    <div class="stat"><div class="label">Input tokens</div><div class="value">${o.total_input_tokens.toLocaleString()}</div></div>
    <div class="stat"><div class="label">Est. model cost</div><div class="value">$${o.est_cost_usd.toFixed(2)}</div></div>`;

  const max = Math.max(1, ...o.by_day.map((d) => d.runs));
  $('#chart-runs').innerHTML = o.by_day.length
    ? o.by_day
        .map(
          (d) =>
            `<div class="bar" style="height:${(d.runs / max) * 100}%" title="${esc(d.day)}: ${d.runs} runs, ${d.low_confidence} low confidence"></div>`,
        )
        .join('')
    : '<p class="hint">No runs recorded yet.</p>';

  $('#distribution').innerHTML = data.distribution.length
    ? data.distribution
        .map((node) => {
          const total = node.options.reduce((a, b) => a + b.runs, 0) || 1;
          return `<div class="dist-node"><h4>${esc(node.node)}</h4>${node.options
            .map(
              (o2) => `<div class="dist-row">
                <span>${esc(o2.answer)}</span>
                <div class="dist-bar"><span style="width:${(o2.runs / total) * 100}%"></span></div>
                <span class="hint">${o2.runs} · conf ${o2.avg_confidence.toFixed(2)}</span>
              </div>`,
            )
            .join('')}</div>`;
        })
        .join('')
    : '<p class="hint">No telemetry yet. Classify something and come back.</p>';
}

// --------------------------------------------------------------- versions

async function loadVersions() {
  const versions = state.current?.versions ?? [];
  const pinned = state.current?.pipeline.pinned_version;
  $('#versions-table tbody').innerHTML = versions.length
    ? versions
        .map(
          (v) => `<tr>
            <td><strong>v${v.version}</strong>${pinned === v.version ? ' <span class="chip">pinned</span>' : ''}</td>
            <td class="hint">${new Date(v.created_at).toLocaleString()}</td>
            <td class="hint">${esc(v.created_by)}</td>
            <td>${
              typeof v.eval_summary?.accuracy === 'number'
                ? `${(v.eval_summary.accuracy * 100).toFixed(0)}% <span class="hint">${esc(v.eval_summary.resolved_model ?? '')}</span>`
                : '<span class="hint">not evaluated</span>'
            }</td>
            <td><button class="btn ghost small" data-pin="${v.version}">${pinned === v.version ? 'Unpin' : 'Pin'}</button></td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="hint">No published versions yet.</td></tr>';

  $$('[data-pin]').forEach((btn) => {
    btn.onclick = async () => {
      const version = Number(btn.dataset.pin);
      await api(`/v1/pipelines/${state.current.pipeline.id}/pin`, {
        method: 'POST',
        body: JSON.stringify({ version: pinned === version ? null : version }),
      });
      await openPipeline(state.current.pipeline.id);
    };
  });

  const shadow = await api(`/v1/pipelines/${state.current.pipeline.id}/shadow`);
  $('#shadow-toggle').checked = shadow.enabled;
  $('#shadow-agreement').textContent = shadow.agreement?.total
    ? `${((shadow.agreement.agreed / shadow.agreement.total) * 100).toFixed(1)}% agreement over ${shadow.agreement.total} run(s)`
    : 'No shadow comparisons yet.';
}

$('#shadow-toggle').onchange = async (e) => {
  await api(`/v1/pipelines/${state.current.pipeline.id}/shadow`, {
    method: 'POST',
    body: JSON.stringify({ enabled: e.target.checked }),
  });
  toast(e.target.checked ? 'Shadow mode on. The draft runs on a worker.' : 'Shadow mode off.', 'ok');
};

$('#btn-archive').onclick = async () => {
  if (!confirm(`Archive ${state.current.pipeline.id}? Its endpoint stops serving.`)) return;
  await api(`/v1/pipelines/${state.current.pipeline.id}`, { method: 'DELETE' });
  state.current = null;
  await loadPipelines();
};

// -------------------------------------------------------- new / templates

$('#btn-new').onclick = () => {
  modal(`
    <h3>New pipeline</h3>
    <div class="field"><label>Id</label><input type="text" id="np-id" placeholder="support-triage"></div>
    <div class="field"><label>Description</label>
      <textarea id="np-desc" rows="4" placeholder="Route support tickets to returns, shipping or billing. Flag angry customers."></textarea></div>
    <div class="row"><button class="btn primary" id="np-create">Create</button></div>
    <p class="hint">Creates an empty pipeline. Press Compile to turn the description into a spec.</p>
  `);
  $('#np-create').onclick = async () => {
    try {
      await api('/v1/pipelines', {
        method: 'POST',
        body: JSON.stringify({ id: $('#np-id').value.trim(), description: $('#np-desc').value }),
      });
      closeModal();
      await loadPipelines();
      await openPipeline($('#np-id').value.trim());
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
};

$('#btn-templates').onclick = async () => {
  const { templates } = await api('/v1/templates');
  modal(`<h3>Template gallery</h3>
    <p class="hint">Each one is a runnable spec with test cases. Starting from a template creates a new pipeline.</p>
    ${templates
      .map(
        (t) => `<div class="option-card">
          <div class="option-name"><span>${esc(t.title)}</span>
            <button class="btn small" data-template="${esc(t.id)}">Use</button></div>
          <p class="hint">${esc(t.description)}</p>
        </div>`,
      )
      .join('')}`);

  $$('[data-template]').forEach((btn) => {
    btn.onclick = async () => {
      const template = templates.find((t) => t.id === btn.dataset.template);
      const id = prompt('Pipeline id', template.id);
      if (!id) return;
      try {
        await api('/v1/pipelines', {
          method: 'POST',
          body: JSON.stringify({ id, spec_yaml: template.spec_yaml, description: template.description }),
        });
        closeModal();
        await loadPipelines();
        await openPipeline(id);
        toast('Template loaded as a draft. Publish when you are ready.', 'ok');
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
  });
};

$('#btn-keys').onclick = async () => {
  const { keys } = await api('/v1/keys');
  modal(`<h3>API keys</h3>
    <p class="hint">Keys are stored hashed. The secret is shown once, at creation.</p>
    <table class="table"><thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th></th></tr></thead><tbody>
    ${
      keys.length
        ? keys
            .map(
              (k) => `<tr>
                <td>${esc(k.name)}</td><td class="mono hint">${esc(k.prefix)}…</td>
                <td>${esc((k.scopes ?? []).join(', '))}</td>
                <td>${k.revoked_at ? '<span class="hint">revoked</span>' : `<button class="btn ghost small" data-revoke="${esc(k.id)}">Revoke</button>`}</td>
              </tr>`,
            )
            .join('')
        : '<tr><td colspan="4" class="hint">No keys yet.</td></tr>'
    }
    </tbody></table>
    <div class="row">
      <input type="text" id="key-name" placeholder="key name" style="flex:1">
      <select id="key-scope"><option value="classify">classify</option><option value="admin">admin</option></select>
      <button class="btn primary" id="key-create">Create</button>
    </div>`);

  $('#key-create').onclick = async () => {
    const res = await api('/v1/keys', {
      method: 'POST',
      body: JSON.stringify({ name: $('#key-name').value.trim() || 'unnamed', scopes: [$('#key-scope').value] }),
    });
    modal(`<h3>Key created</h3>
      <p class="hint">${esc(res.warning)}</p>
      <pre>${esc(res.key)}</pre>`);
  };
  $$('[data-revoke]').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/v1/keys/${btn.dataset.revoke}`, { method: 'DELETE' });
      closeModal();
    };
  });
};

// ------------------------------------------------------------------- tabs

$('#tabs').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  state.tab = button.dataset.tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b === button));
  $$('.tab').forEach((section) => section.classList.toggle('hidden', section.dataset.tab !== state.tab));
  void loadTab(state.tab);
});

async function loadTab(tab) {
  if (!state.current) return;
  try {
    if (tab === 'test') renderTests();
    if (tab === 'runs') await loadRuns();
    if (tab === 'analytics') await loadAnalytics();
    if (tab === 'versions') await loadVersions();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

void boot();
