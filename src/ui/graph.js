/**
 * The node graph.
 *
 * Renders the spec's topological layers as SVG: one column per layer, so the
 * picture shows what the executor actually does — everything in column one is
 * a single model call, and a second column means a second round trip.
 */

const NODE_W = 190;
const NODE_H = 62;
const GAP_X = 70;
const GAP_Y = 22;
const PAD = 16;

const TYPE_COLOR = {
  choice: '#5b9dff',
  noul: '#3ecf8e',
  score: '#f2b544',
  rule: '#a78bfa',
};

/** Mirrors the executor's layering, including speculative evaluation. */
export function layersOf(spec) {
  const ids = Object.keys(spec.nodes ?? {});
  const idSet = new Set(ids);
  const refsOf = (text) =>
    String(text ?? '')
      .match(/[A-Za-z_$][A-Za-z0-9_$]*/g)
      ?.filter((r) => idSet.has(r)) ?? [];

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

function edgesOf(spec) {
  const ids = new Set(Object.keys(spec.nodes ?? {}));
  const edges = [];
  for (const [id, node] of Object.entries(spec.nodes ?? {})) {
    const sources = new Set();
    const scan = (text) =>
      String(text ?? '').match(/[A-Za-z_$][A-Za-z0-9_$]*/g)?.forEach((r) => {
        if (ids.has(r) && r !== id) sources.add(r);
      });
    scan(node.when);
    if (node.type === 'rule') scan(node.expr);
    for (const from of sources) {
      edges.push({ from, to: id, conditional: Boolean(node.when) });
    }
  }
  return edges;
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

  const layers = layersOf(spec);
  const tallest = Math.max(...layers.map((l) => l.length), 1);
  const width = PAD * 2 + layers.length * NODE_W + (layers.length - 1) * GAP_X + 140;
  const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * GAP_Y + 30;

  const pos = new Map();
  layers.forEach((layer, col) => {
    const colHeight = layer.length * NODE_H + (layer.length - 1) * GAP_Y;
    const top = PAD + 24 + (height - PAD * 2 - 24 - colHeight) / 2;
    layer.forEach((id, row) => {
      pos.set(id, { x: PAD + col * (NODE_W + GAP_X), y: top + row * (NODE_H + GAP_Y) });
    });
  });

  const parts = [`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`];
  parts.push(`<defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)"/>
    </marker>
  </defs>`);

  // Layer captions: the number of model calls is the number of columns.
  layers.forEach((layer, col) => {
    const x = PAD + col * (NODE_W + GAP_X);
    const label = layer.some((id) => nodes[id].type !== 'rule')
      ? `Model call ${col + 1}`
      : 'local rules';
    parts.push(
      `<text x="${x}" y="${PAD + 8}" font-size="10" fill="var(--muted)" letter-spacing="0.06em">${esc(label.toUpperCase())}</text>`,
    );
  });

  for (const edge of edgesOf(spec)) {
    const a = pos.get(edge.from);
    const b = pos.get(edge.to);
    if (!a || !b) continue;
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const mid = (x1 + x2) / 2;
    parts.push(
      `<path d="M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}" fill="none" ` +
        `stroke="var(--muted)" stroke-width="1.2" opacity="${edge.conditional ? 0.55 : 0.85}" ` +
        `${edge.conditional ? 'stroke-dasharray="4 3"' : ''} marker-end="url(#arrow)"/>`,
    );
  }

  for (const id of ids) {
    const node = nodes[id];
    const { x, y } = pos.get(id);
    const color = TYPE_COLOR[node.type] ?? 'var(--muted)';
    const detail =
      node.type === 'choice'
        ? `${Object.keys(node.criteria ?? {}).length} options`
        : node.type === 'rule'
          ? clip(node.expr ?? '', 26)
          : node.type === 'score'
            ? `${node.scale?.min ?? 0}–${node.scale?.max ?? 1}`
            : 'yes / no';

    parts.push(`<g class="node-box" data-node="${esc(id)}">
      <rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="9"
            fill="var(--panel-2)" stroke="${selected === id ? 'var(--accent)' : 'var(--line)'}"
            stroke-width="${selected === id ? 2 : 1}" class="${selected === id ? 'sel' : ''}"/>
      <rect x="${x}" y="${y}" width="4" height="${NODE_H}" rx="2" fill="${color}"/>
      <text x="${x + 14}" y="${y + 22}" font-size="13" fill="var(--text)" font-weight="600">${esc(clip(id, 20))}</text>
      <text x="${x + 14}" y="${y + 39}" font-size="11" fill="${color}">${esc(node.type)}</text>
      <text x="${x + 14}" y="${y + 54}" font-size="11" fill="var(--muted)">${esc(detail)}</text>
      ${node.when ? `<title>${esc(`when: ${node.when}`)}</title>` : ''}
      ${node.lazy ? `<text x="${x + NODE_W - 12}" y="${y + 18}" font-size="10" fill="var(--warn)" text-anchor="end">lazy</text>` : ''}
    </g>`);
  }

  // The output node, so the picture ends where the caller's response does.
  const lastX = PAD + layers.length * (NODE_W + GAP_X);
  const outY = PAD + 24 + (height - PAD * 2 - 24 - NODE_H) / 2;
  const outputKeys = Object.keys(spec.output ?? {});
  parts.push(`<g>
    <rect x="${lastX}" y="${outY}" width="120" height="${NODE_H}" rx="9" fill="var(--panel-2)"
          stroke="var(--line)" stroke-dasharray="4 3"/>
    <text x="${lastX + 14}" y="${outY + 24}" font-size="12" fill="var(--text)" font-weight="600">output</text>
    <text x="${lastX + 14}" y="${outY + 42}" font-size="11" fill="var(--muted)">${outputKeys.length} field(s)</text>
  </g>`);

  parts.push('</svg>');
  container.innerHTML = parts.join('');

  container.querySelectorAll('.node-box').forEach((el) => {
    el.addEventListener('click', () => onSelect?.(el.dataset.node));
  });

  return { layers };
}
