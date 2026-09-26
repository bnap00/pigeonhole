/**
 * The sandboxed expression language used by `when` conditions and `rule` nodes.
 *
 * A self-contained Pratt parser over a deliberately small grammar, rather than
 * CEL or JSONata: it adds no dependency and its semantics are all in this file.
 *
 * There is no `eval`, no `Function`, no property access on prototypes, and no
 * way to reach a host object. The only values that exist are the ones placed in
 * the evaluation scope.
 */

type Tok =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'id'; v: string }
  | { k: 'op'; v: string }
  | { k: 'eof' };

const OPS = [
  '===', '!==', '==', '!=', '<=', '>=', '&&', '||', '??',
  '<', '>', '+', '-', '*', '/', '%', '!', '?', ':', '(', ')', '[', ']', ',', '.',
];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '"' || c === "'") {
      const quote = c;
      let s = '';
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const esc = src[i + 1];
          s += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
          i += 2;
        } else {
          s += src[i++];
        }
      }
      if (i >= src.length) throw new ExprError(`unterminated string in expression`);
      i++;
      out.push({ k: 'str', v: s });
      continue;
    }
    if (c >= '0' && c <= '9') {
      let s = '';
      while (i < src.length && /[0-9._]/.test(src[i])) s += src[i++];
      const n = Number(s.replace(/_/g, ''));
      if (!Number.isFinite(n)) throw new ExprError(`bad number literal "${s}"`);
      out.push({ k: 'num', v: n });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let s = '';
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) s += src[i++];
      out.push({ k: 'id', v: s });
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`unexpected character "${c}" in expression`);
    i += op.length;
    out.push({ k: 'op', v: op });
  }
  out.push({ k: 'eof' });
  return out;
}

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExprError';
  }
}

type Node =
  | { t: 'lit'; v: unknown }
  | { t: 'ref'; path: string[] }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'cond'; c: Node; a: Node; b: Node }
  | { t: 'arr'; items: Node[] }
  | { t: 'call'; name: string; args: Node[] }
  | { t: 'index'; a: Node; i: Node };

/** Binding power per infix operator. Higher binds tighter. */
const BP: Record<string, number> = {
  '??': 1, '||': 2, '&&': 3,
  '==': 4, '!=': 4, '===': 4, '!==': 4,
  '<': 5, '>': 5, '<=': 5, '>=': 5,
  in: 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7, '%': 7,
};

class Parser {
  private pos = 0;
  private readonly toks: Tok[];

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok { return this.toks[this.pos]; }
  private next(): Tok { return this.toks[this.pos++]; }

  private eat(op: string): void {
    const t = this.peek();
    if (t.k === 'op' && t.v === op) { this.pos++; return; }
    if (t.k === 'id' && t.v === op) { this.pos++; return; }
    throw new ExprError(`expected "${op}"`);
  }

  private isOp(op: string): boolean {
    const t = this.peek();
    return t.k === 'op' && t.v === op;
  }

  parse(): Node {
    const n = this.expr(0);
    if (this.peek().k !== 'eof') throw new ExprError('trailing tokens in expression');
    return n;
  }

  private expr(minBp: number): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      // `in` is spelled as an identifier but behaves as an infix operator.
      const op = t.k === 'op' ? t.v : t.k === 'id' && t.v === 'in' ? 'in' : null;
      if (op === '?' && minBp <= 0) {
        this.next();
        const a = this.expr(0);
        this.eat(':');
        const b = this.expr(0);
        left = { t: 'cond', c: left, a, b };
        continue;
      }
      if (!op) break;
      const bp = BP[op];
      if (bp === undefined || bp <= minBp) break;
      this.next();
      const right = this.expr(bp);
      left = { t: 'bin', op, a: left, b: right };
    }
    return left;
  }

  private unary(): Node {
    if (this.isOp('!')) { this.next(); return { t: 'un', op: '!', a: this.unary() }; }
    if (this.isOp('-')) { this.next(); return { t: 'un', op: '-', a: this.unary() }; }
    return this.postfix(this.primary());
  }

  private postfix(base: Node): Node {
    let node = base;
    for (;;) {
      if (this.isOp('.')) {
        this.next();
        const t = this.next();
        if (t.k !== 'id') throw new ExprError('expected a property name after "."');
        node = node.t === 'ref'
          ? { t: 'ref', path: [...node.path, t.v] }
          : { t: 'index', a: node, i: { t: 'lit', v: t.v } };
        continue;
      }
      if (this.isOp('[')) {
        this.next();
        const i = this.expr(0);
        this.eat(']');
        node = { t: 'index', a: node, i };
        continue;
      }
      break;
    }
    return node;
  }

  private primary(): Node {
    const t = this.next();
    if (t.k === 'num') return { t: 'lit', v: t.v };
    if (t.k === 'str') return { t: 'lit', v: t.v };
    if (t.k === 'op' && t.v === '(') {
      const n = this.expr(0);
      this.eat(')');
      return n;
    }
    if (t.k === 'op' && t.v === '[') {
      const items: Node[] = [];
      if (!this.isOp(']')) {
        for (;;) {
          items.push(this.expr(0));
          if (this.isOp(',')) { this.next(); continue; }
          break;
        }
      }
      this.eat(']');
      return { t: 'arr', items };
    }
    if (t.k === 'id') {
      if (t.v === 'true') return { t: 'lit', v: true };
      if (t.v === 'false') return { t: 'lit', v: false };
      if (t.v === 'null') return { t: 'lit', v: null };
      if (this.isOp('(')) {
        this.next();
        const args: Node[] = [];
        if (!this.isOp(')')) {
          for (;;) {
            args.push(this.expr(0));
            if (this.isOp(',')) { this.next(); continue; }
            break;
          }
        }
        this.eat(')');
        return { t: 'call', name: t.v, args };
      }
      return { t: 'ref', path: [t.v] };
    }
    throw new ExprError('unexpected end of expression');
  }
}

/** The complete function allow-list. Nothing else is callable. */
const FUNCS: Record<string, (...args: any[]) => unknown> = {
  len: (v) => (typeof v === 'string' || Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0),
  lower: (v) => String(v ?? '').toLowerCase(),
  upper: (v) => String(v ?? '').toUpperCase(),
  trim: (v) => String(v ?? '').trim(),
  contains: (h, n) => (Array.isArray(h) ? h.includes(n) : String(h ?? '').includes(String(n ?? ''))),
  startsWith: (h, n) => String(h ?? '').startsWith(String(n ?? '')),
  endsWith: (h, n) => String(h ?? '').endsWith(String(n ?? '')),
  abs: (v) => Math.abs(Number(v)),
  min: (...v: number[]) => Math.min(...v.map(Number)),
  max: (...v: number[]) => Math.max(...v.map(Number)),
  round: (v, d = 0) => { const f = 10 ** Number(d); return Math.round(Number(v) * f) / f; },
  floor: (v) => Math.floor(Number(v)),
  ceil: (v) => Math.ceil(Number(v)),
  number: (v) => Number(v),
  string: (v) => (v === null || v === undefined ? '' : String(v)),
  defined: (v) => v !== null && v !== undefined,
  coalesce: (...v: unknown[]) => v.find((x) => x !== null && x !== undefined) ?? null,
};

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function lookup(scope: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = scope;
  for (const key of path) {
    if (FORBIDDEN.has(key)) throw new ExprError(`forbidden property "${key}"`);
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * A node reference used as a scalar means its primary answer.
 *
 * The spec writes `when: department == "returns"` and `output: department.choice`
 * for the same node, so a node's scope entry has to behave as both. Node results
 * are the only objects carrying both `type` and `value`, so unwrapping them in
 * scalar position is unambiguous: `angry > 0.7` reads the probability,
 * `angry.p` reads it explicitly, and both mean the same thing.
 */
export function unwrapNodeValue(v: unknown): unknown {
  return unwrap(v);
}

function unwrap(v: unknown): unknown {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (Object.hasOwn(o, 'type') && Object.hasOwn(o, 'value')) return o.value;
  }
  return v;
}

function truthy(raw: unknown): boolean {
  const v = unwrap(raw);
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

function evaluate(node: Node, scope: Record<string, unknown>): unknown {
  switch (node.t) {
    case 'lit':
      return node.v;
    case 'ref':
      return lookup(scope, node.path);
    case 'arr':
      return node.items.map((i) => evaluate(i, scope));
    case 'index': {
      const base = evaluate(node.a, scope);
      const key = evaluate(node.i, scope);
      if (base === null || base === undefined) return undefined;
      if (typeof key === 'string' && FORBIDDEN.has(key)) throw new ExprError(`forbidden property "${key}"`);
      if (Array.isArray(base)) return base[Number(key)];
      if (typeof base === 'object') return (base as Record<string, unknown>)[String(key)];
      return undefined;
    }
    case 'un': {
      const a = evaluate(node.a, scope);
      return node.op === '!' ? !truthy(a) : -Number(unwrap(a));
    }
    case 'cond':
      return truthy(evaluate(node.c, scope)) ? evaluate(node.a, scope) : evaluate(node.b, scope);
    case 'call': {
      const fn = FUNCS[node.name];
      if (!fn) throw new ExprError(`unknown function "${node.name}"`);
      return fn(...node.args.map((a) => unwrap(evaluate(a, scope))));
    }
    case 'bin': {
      // Short-circuit before evaluating the right side.
      if (node.op === '&&') return truthy(evaluate(node.a, scope)) ? evaluate(node.b, scope) : false;
      if (node.op === '||') {
        const a = evaluate(node.a, scope);
        return truthy(a) ? unwrap(a) : evaluate(node.b, scope);
      }
      if (node.op === '??') {
        const a = unwrap(evaluate(node.a, scope));
        return a === null || a === undefined ? evaluate(node.b, scope) : a;
      }
      const a = unwrap(evaluate(node.a, scope));
      const b = unwrap(evaluate(node.b, scope));
      switch (node.op) {
        case '==':
        case '===':
          return looseEq(a, b);
        case '!=':
        case '!==':
          return !looseEq(a, b);
        case '<': return Number(a) < Number(b);
        case '>': return Number(a) > Number(b);
        case '<=': return Number(a) <= Number(b);
        case '>=': return Number(a) >= Number(b);
        case '+':
          return typeof a === 'string' || typeof b === 'string' ? String(a ?? '') + String(b ?? '') : Number(a) + Number(b);
        case '-': return Number(a) - Number(b);
        case '*': return Number(a) * Number(b);
        case '/': return Number(a) / Number(b);
        case '%': return Number(a) % Number(b);
        case 'in':
          if (Array.isArray(b)) return b.includes(a);
          if (typeof b === 'string') return b.includes(String(a));
          if (b && typeof b === 'object') return Object.hasOwn(b as object, String(a));
          return false;
        default:
          throw new ExprError(`unknown operator "${node.op}"`);
      }
    }
  }
}

/** Strict equality, except that numeric strings compare numerically. */
function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
  if (typeof a === 'string' && typeof b === 'number') return Number(a) === b;
  return false;
}

export type CompiledExpr = {
  source: string;
  /** Top-level identifiers the expression reads, used to build the node graph. */
  refs: string[];
  eval(scope: Record<string, unknown>): unknown;
};

const cache = new Map<string, CompiledExpr>();

function collectRefs(node: Node, out: Set<string>): void {
  switch (node.t) {
    case 'ref': out.add(node.path[0]); break;
    case 'un': collectRefs(node.a, out); break;
    case 'bin': collectRefs(node.a, out); collectRefs(node.b, out); break;
    case 'cond': collectRefs(node.c, out); collectRefs(node.a, out); collectRefs(node.b, out); break;
    case 'arr': node.items.forEach((i) => collectRefs(i, out)); break;
    case 'call': node.args.forEach((a) => collectRefs(a, out)); break;
    case 'index': collectRefs(node.a, out); collectRefs(node.i, out); break;
    case 'lit': break;
  }
}

/** Parses once and memoizes; specs are hot and re-parsing them per request is waste. */
export function compileExpr(source: string): CompiledExpr {
  const hit = cache.get(source);
  if (hit) return hit;
  let ast: Node;
  try {
    ast = new Parser(tokenize(source)).parse();
  } catch (err) {
    throw new ExprError(`${(err as Error).message} in \`${source}\``);
  }
  const refs = new Set<string>();
  collectRefs(ast, refs);
  const compiled: CompiledExpr = {
    source,
    refs: [...refs],
    eval: (scope) => evaluate(ast, scope),
  };
  if (cache.size > 2000) cache.clear();
  cache.set(source, compiled);
  return compiled;
}

export const evalExpr = (source: string, scope: Record<string, unknown>): unknown =>
  compileExpr(source).eval(scope);

export const evalCondition = (source: string, scope: Record<string, unknown>): boolean =>
  truthy(compileExpr(source).eval(scope));
