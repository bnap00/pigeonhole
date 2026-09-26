/** A structured diff between two specs. Nothing goes live without review. */
import type { PipelineSpec } from '../spec/types.js';

export interface SpecDiff {
  nodes: {
    added: string[];
    removed: string[];
    changed: { id: string; options_added: string[]; options_removed: string[]; fields: string[] }[];
  };
  output: { added: string[]; removed: string[]; changed: string[] };
  tests: { before: number; after: number };
  input_changed: boolean;
  model_changed: boolean;
  summary: string;
}

const optionsOf = (spec: PipelineSpec, id: string): string[] => {
  const node = spec.nodes[id];
  return node && node.type === 'choice' ? Object.keys(node.criteria) : [];
};

export function diffSpecs(before: PipelineSpec | null, after: PipelineSpec): SpecDiff {
  const beforeNodes = before ? Object.keys(before.nodes) : [];
  const afterNodes = Object.keys(after.nodes);

  const added = afterNodes.filter((n) => !beforeNodes.includes(n));
  const removed = beforeNodes.filter((n) => !afterNodes.includes(n));
  const changed: SpecDiff['nodes']['changed'] = [];

  for (const id of afterNodes.filter((n) => beforeNodes.includes(n))) {
    const a = before!.nodes[id] as unknown as Record<string, unknown>;
    const b = after.nodes[id] as unknown as Record<string, unknown>;
    const beforeOptions = optionsOf(before!, id);
    const afterOptions = optionsOf(after, id);
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
      (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]),
    );
    if (fields.length > 0) {
      changed.push({
        id,
        options_added: afterOptions.filter((o) => !beforeOptions.includes(o)),
        options_removed: beforeOptions.filter((o) => !afterOptions.includes(o)),
        fields,
      });
    }
  }

  const beforeOut = before ? Object.keys(before.output) : [];
  const afterOut = Object.keys(after.output);
  const outputChanged = afterOut.filter(
    (k) => beforeOut.includes(k) && JSON.stringify(before!.output[k]) !== JSON.stringify(after.output[k]),
  );

  const diff: SpecDiff = {
    nodes: { added, removed, changed },
    output: {
      added: afterOut.filter((k) => !beforeOut.includes(k)),
      removed: beforeOut.filter((k) => !afterOut.includes(k)),
      changed: outputChanged,
    },
    tests: { before: before?.tests?.length ?? 0, after: after.tests?.length ?? 0 },
    input_changed: JSON.stringify(before?.input ?? null) !== JSON.stringify(after.input ?? null),
    model_changed: JSON.stringify(before?.model ?? null) !== JSON.stringify(after.model ?? null),
    summary: '',
  };
  diff.summary = summarize(diff);
  return diff;
}

function summarize(d: SpecDiff): string {
  const parts: string[] = [];
  if (d.nodes.added.length) parts.push(`${d.nodes.added.length} node(s) added`);
  if (d.nodes.removed.length) parts.push(`${d.nodes.removed.length} node(s) removed`);
  if (d.nodes.changed.length) {
    const optionsAdded = d.nodes.changed.reduce((n, c) => n + c.options_added.length, 0);
    const optionsRemoved = d.nodes.changed.reduce((n, c) => n + c.options_removed.length, 0);
    let text = `${d.nodes.changed.length} node(s) changed`;
    if (optionsAdded || optionsRemoved) text += ` (${optionsAdded} option(s) added, ${optionsRemoved} removed)`;
    parts.push(text);
  }
  if (d.output.added.length || d.output.removed.length || d.output.changed.length) {
    parts.push('output mapping changed');
  }
  if (d.input_changed) parts.push('input schema changed');
  if (d.tests.before !== d.tests.after) parts.push(`tests ${d.tests.before} → ${d.tests.after}`);
  return parts.length > 0 ? parts.join(', ') : 'no changes';
}
