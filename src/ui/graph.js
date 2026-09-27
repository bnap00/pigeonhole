/**
 * The node graph.
 *
 * Renders the spec as the executor runs it. Each model call is a band: every
 * node inside one band is asked in a single request, and a second band means
 * a second round trip. Inside a band, a node gated on another (`when:`) sits
 * to its right — it is still asked in the same call, speculatively, and its
 * answer is used only if the gate passes. Edges end at the output fields that
 * read each node, so the picture ends where the caller's response does.
 */

const NODE_H = 62;
const COL_GAP = 48;    // between columns inside one band
const BAND_GAP = 40;   // between bands
const BAND_PAD = 14;
const ROW_GAP = 18;
const PAD = 12;
const CAPTION_H = 26;
const OUT_W = 190;
const OUT_ROW = 17;
const OUT_MAX_ROWS = 12;

const TYPE_COLOR = {
  choice: '#5b9dff',
  noul: '#3ecf8e',
  score: '#f2b544',
  rule: '#a78bfa',
};

const identifiers = (text) => String(text ?? '').match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];

/** Mirrors the executor's layering, including speculative evaluation. */
export function layersOf(spec) {
  const ids = Object.keys(spec.nodes ?? {});
  const idSet = new Set(ids);
  const refsOf = (text) => identifiers(text).filter((r) => idSet.has(r));

  const blocking = new Map();
  for (const id of ids) {
    const node = spec.nodes[id];
    const deps = new Set([...refsOf(node.when), ...(node.type === 'rule' ? refsOf(node.expr) : [])]);
    deps.delete(id);
    // A speculative model node does not wait for its gate.
    const speculative = node.type !== 'rule' && !node.lazy;
    blocking.set(id, speculative ? new Set() : deps);
  }

  const layers = [];
  const done = new Set();
  let remaining = [...ids];
  let guard = 0;
  while (remaining.length && guard++ < 50) {
    const ready = remaining.filter((id) => [...blocking.get(id)].every((d) => done.has(d)));
    if (!ready.length) { layers.push(remaining.slice()); break; }
    layers.push(ready.sort());
    ready.forEach((id) => done.add(id));
    remaining = remaining.filter((id) => !done.has(id));
  }
  return layers;
}

/** Every node another node reads: through `when:`, and for rules through `expr`. */
function depsOf(spec, id) {
  const ids = new Set(Object.keys(spec.nodes ?? {}));
  const node = spec.nodes[id];
  const out = new Map();
  for (const r of identifiers(node.when)) if (ids.has(r) && r !== id) out.set(r, 'when');
  if (node.type === 'rule') for (const r of identifiers(node.expr)) if (ids.has(r) && r !== id) out.set(r, 'expr');
  return out;
}

/**
 * Columns within one band: a node goes one column to the right of the
 * furthest node in the same band that it depends on.
 */
function columnsOf(spec, layer) {
  const inLayer = new Set(layer);
  const depth = new Map();
  const visit = (id, trail) => {
    if (depth.has(id)) return depth.get(id);
    if (trail.has(id)) return 0; // a cycle; the linter reports it
    trail.add(id);
    let d = 0;
    for (const dep of depsOf(spec, id).keys()) {
      if (inLayer.has(dep)) d = Math.max(d, visit(dep, trail) + 1);
    }
    trail.delete(id);
    depth.set(id, d);
    return d;
  };
  layer.forEach((id) => visit(id, new Set()));
  const columns = [];
  for (const id of layer) (columns[depth.get(id)] ??= []).push(id);
  return columns.map((c) => c ?? []);
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

export function renderGraph(container, spec, { selected, onSelect } = {}) {
  const nodes = spec?.nodes ?? {};
  const ids = Object.keys(nodes);
  if (!ids.length) {
    container.innerHTML = '<p class="muted">No nodes yet. Write a description and press Compile, or edit the YAML.</p>';
    return { layers: [] };
  }

  // Wide enough for the longest id (13px semibold is ~7.4px a character), within reason.
  const longest = Math.max(...ids.map((id) => id.length));
  const NODE_W = Math.round(Math.min(260, Math.max(160, longest * 7.4 + 34)));
  const idChars = Math.floor((NODE_W - 34) / 7.4);

  const layers = layersOf(spec);
  const bands = layers.map((layer) => ({ layer, columns: columnsOf(spec, layer) }));
  const tallest = Math.max(...bands.flatMap((b) => b.columns.map((c) => c.length)), 1);
  const nodesH = tallest * NODE_H + (tallest - 1) * ROW_GAP;

  const outputKeys = Object.keys(spec.output ?? {});
  const shownKeys = outputKeys.slice(0, OUT_MAX_ROWS);
  const outH = 34 + Math.max(shownKeys.length, 1) * OUT_ROW + (outputKeys.length > shownKeys.length ? OUT_ROW : 0);

  const bodyH = Math.max(nodesH, outH);
  const bandTop = PAD;
  const bandH = CAPTION_H + bodyH + BAND_PAD * 2;
  const height = bandTop + bandH + PAD;
  const centre = bandTop + CAPTION_H + BAND_PAD + bodyH / 2;

  // Place bands left to right, columns within each band.
  const pos = new Map();
  let x = PAD;
  for (const band of bands) {
    band.x = x;
    let cx = x + BAND_PAD;
    for (const column of band.columns) {
      const colH = column.length * NODE_H + (column.length - 1) * ROW_GAP;
      column.forEach((id, row) => pos.set(id, { x: cx, y: centre - colH / 2 + row * (NODE_H + ROW_GAP) }));
      cx += NODE_W + COL_GAP;
    }
    band.w = cx - COL_GAP + BAND_PAD - x;
    x += band.w + BAND_GAP;
  }
  const outX = x + 10;
  const outY = centre - outH / 2;
  const width = outX + OUT_W + PAD;

  // Shrinks to fit its panel, down to 80%; past that the panel scrolls, so text stays legible.
  const parts = [`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
    style="max-width:100%;height:auto;min-width:${Math.round(width * 0.8)}px">`];
  parts.push(`<defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)"/>
    </marker>
  </defs>`);

  // Bands: the number of model calls is the number of bands with a model node in them.
  let call = 0;
  for (const band of bands) {
    const isModel = band.layer.some((id) => nodes[id].type !== 'rule');
    const label = isModel ? `Model call ${++call}` : 'Local rules';
    const gated = band.columns.length > 1 && isModel;
    parts.push(`<g>
      <rect x="${band.x}" y="${bandTop}" width="${band.w}" height="${bandH}" rx="12"
            fill="var(--panel-2)" fill-opacity="0.35" stroke="var(--line)"/>
      <text x="${band.x + BAND_PAD}" y="${bandTop + 18}" font-size="10" fill="var(--muted)" letter-spacing="0.06em">${esc(label.toUpperCase())}</text>
      ${gated ? `<text x="${band.x + band.w - BAND_PAD}" y="${bandTop + 18}" font-size="10" fill="var(--muted)" text-anchor="end">gated nodes asked in the same call</text>` : ''}
    </g>`);
  }

  const curve = (x1, y1, x2, y2, { dashed = false, opacity = 0.85 } = {}) => {
    const mid = (x1 + x2) / 2;
    return `<path d="M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}" fill="none" ` +
      `stroke="var(--muted)" stroke-width="1.2" opacity="${opacity}" ` +
      `${dashed ? 'stroke-dasharray="4 3"' : ''} marker-end="url(#arrow)"/>`;
  };

  // Node to node: a gate (dashed) or a rule's input (solid), always left to right.
  for (const id of ids) {
    const b = pos.get(id);
    for (const [from, kind] of depsOf(spec, id)) {
      const a = pos.get(from);
      if (!a || a.x >= b.x) continue;
      parts.push(curve(a.x + NODE_W, a.y + NODE_H / 2, b.x, b.y + NODE_H / 2, { dashed: kind === 'when', opacity: kind === 'when' ? 0.6 : 0.85 }));
    }
  }

  // Node to the output fields that read it.
  const rowY = (i) => outY + 34 + i * OUT_ROW + OUT_ROW / 2 - 4;
  outputKeys.forEach((key, i) => {
    const y2 = rowY(Math.min(i, OUT_MAX_ROWS));
    const readers = new Set(identifiers(JSON.stringify(spec.output[key])).filter((r) => r in nodes));
    for (const from of readers) {
      const a = pos.get(from);
      if (a) parts.push(curve(a.x + NODE_W, a.y + NODE_H / 2, outX, y2, { opacity: 0.3 }));
    }
  });

  for (const id of ids) {
    const node = nodes[id];
    const { x: nx, y } = pos.get(id);
    const color = TYPE_COLOR[node.type] ?? 'var(--muted)';
    const detail =
      node.type === 'choice'
        ? `${Object.keys(node.criteria ?? {}).length} options`
        : node.type === 'rule'
          ? clip(node.expr ?? '', idChars + 4)
          : node.type === 'score'
            ? `${node.scale?.min ?? 0}–${node.scale?.max ?? 1}`
            : 'yes / no';
    const tip = [id, node.type, node.when ? `when: ${node.when}` : '', node.type === 'rule' ? `expr: ${node.expr}` : '']
      .filter(Boolean)
      .join('\n');

    parts.push(`<g class="node-box" data-node="${esc(id)}">
      <title>${esc(tip)}</title>
      <rect x="${nx}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="9"
            fill="var(--panel-2)" stroke="${selected === id ? 'var(--accent)' : 'var(--line)'}"
            stroke-width="${selected === id ? 2 : 1}" class="${selected === id ? 'sel' : ''}"/>
      <rect x="${nx}" y="${y}" width="4" height="${NODE_H}" rx="2" fill="${color}"/>
      <text x="${nx + 14}" y="${y + 22}" font-size="13" fill="var(--text)" font-weight="600">${esc(clip(id, idChars))}</text>
      <text x="${nx + 14}" y="${y + 39}" font-size="11" fill="${color}">${esc(node.type)}${node.when ? '<tspan fill="var(--muted)"> · gated</tspan>' : ''}</text>
      <text x="${nx + 14}" y="${y + 54}" font-size="11" fill="var(--muted)">${esc(detail)}</text>
      ${node.lazy ? `<text x="${nx + NODE_W - 12}" y="${y + 18}" font-size="10" fill="var(--warn)" text-anchor="end">lazy</text>` : ''}
    </g>`);
  }

  // The output: every field the caller gets back.
  parts.push(`<g>
    <title>${esc(outputKeys.map((k) => `${k}: ${typeof spec.output[k] === 'string' ? spec.output[k] : JSON.stringify(spec.output[k])}`).join('\n'))}</title>
    <rect x="${outX}" y="${outY}" width="${OUT_W}" height="${outH}" rx="9" fill="var(--panel-2)"
          stroke="var(--line)" stroke-dasharray="4 3"/>
    <text x="${outX + 14}" y="${outY + 22}" font-size="12" fill="var(--text)" font-weight="600">output</text>
    ${shownKeys.length
      ? shownKeys.map((k, i) => `<text x="${outX + 14}" y="${rowY(i) + 4}" font-size="11" fill="var(--muted)" class="mono">${esc(clip(k, 24))}</text>`).join('')
      : `<text x="${outX + 14}" y="${rowY(0) + 4}" font-size="11" fill="var(--muted)">no fields</text>`}
    ${outputKeys.length > shownKeys.length
      ? `<text x="${outX + 14}" y="${rowY(shownKeys.length) + 4}" font-size="11" fill="var(--muted)">+${outputKeys.length - shownKeys.length} more</text>`
      : ''}
  </g>`);

  parts.push('</svg>');
  container.innerHTML = parts.join('');

  container.querySelectorAll('.node-box').forEach((el) => {
    el.addEventListener('click', () => onSelect?.(el.dataset.node));
  });

  return { layers };
}
