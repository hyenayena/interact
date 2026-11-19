export const GRAPH_LIMITS = {nodes: 500, edges: 2000, inputBytes: 262144, label: 120, title: 120} as const;
export const NODE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const EDGE_KINDS = ['plain', 'directed', 'bidirectional'] as const;
export const COLORS: Readonly<Record<string, string>> = Object.freeze({
	gray: '#8b949e',
	red: '#f85149',
	orange: '#f0883e',
	yellow: '#d4a72c',
	green: '#3fb950',
	teal: '#2dd4bf',
	blue: '#58a6ff',
	purple: '#a371f7',
	pink: '#f778ba',
});

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]');

export type EdgeKind = (typeof EDGE_KINDS)[number];
export type GraphNode = {id: string; label: string; size: number; color: string};
export type GraphEdge = {from: string; to: string; kind: EdgeKind};
export type GraphInput = {title?: string; nodes: GraphNode[]; edges: GraphEdge[]};
export type EdgeDiff = {added: GraphEdge[]; removed: GraphEdge[]; changed: {before: GraphEdge; after: GraphEdge}[]};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const echo = (v: unknown): string => (typeof v === 'string' && NODE_ID_RE.test(v) ? v : '?');

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`${where}: unknown key`);
	}
}

function checkText(value: unknown, max: number, where: string): string {
	if (typeof value !== 'string') throw new Error(`${where}: must be a string`);
	const text = value.trim();
	if (UNSAFE.test(text)) throw new Error(`${where}: contains control characters`);
	if (Array.from(text).length > max) throw new Error(`${where}: longer than ${max} characters`);
	return text;
}

export function resolveColor(value: unknown, where: string): string {
	if (typeof value !== 'string') throw new Error(`${where}: must be a color name or a hex color`);
	const named = Object.hasOwn(COLORS, value) ? COLORS[value] : undefined;
	if (named) return named;
	if (HEX_RE.test(value)) return value.toLowerCase();
	throw new Error(`${where}: not a color (use ${Object.keys(COLORS).join(', ')} or #rgb / #rrggbb)`);
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}\n${b}` : `${b}\n${a}`);

function checkEdgeList(ids: ReadonlySet<string>, value: unknown, path: string): GraphEdge[] {
	if (!Array.isArray(value)) throw new Error(`${path}: must be a list`);
	if (value.length > GRAPH_LIMITS.edges) throw new Error(`${path}: more than ${GRAPH_LIMITS.edges} edges`);
	const seen = new Set<string>();
	const out: GraphEdge[] = [];
	value.forEach((item: unknown, i) => {
		const where = `${path}[${i}]`;
		if (!isObject(item)) throw new Error(`${where}: must be an object`);
		checkKeys(item, ['from', 'to', 'kind'], where);
		for (const end of ['from', 'to'] as const) {
			const id = item[end];
			if (typeof id !== 'string' || !ids.has(id)) throw new Error(`${where}.${end}: no such node${typeof id === 'string' && NODE_ID_RE.test(id) ? ` "${id}"` : ''}`);
		}
		const from = item.from as string;
		const to = item.to as string;
		if (from === to) throw new Error(`${where}: an edge cannot join a node to itself ("${echo(from)}")`);
		const kind = item.kind === undefined ? 'plain' : item.kind;
		if (typeof kind !== 'string' || !(EDGE_KINDS as readonly string[]).includes(kind)) throw new Error(`${where}.kind: must be ${EDGE_KINDS.join(', ')}`);
		const key = pairKey(from, to);
		if (seen.has(key)) throw new Error(`${where}: "${echo(from)}" and "${echo(to)}" already have an edge (use kind bidirectional for both directions)`);
		seen.add(key);
		out.push({from, to, kind: kind as EdgeKind});
	});
	return out;
}

export function checkEdges(nodes: readonly {id: string}[], value: unknown): GraphEdge[] {
	return checkEdgeList(new Set(nodes.map(n => n.id)), value, 'edges');
}

export function validateGraph(value: unknown): GraphInput {
	if (!isObject(value)) throw new Error('The graph must be a JSON object');
	checkKeys(value, ['title', 'nodes', 'edges'], 'graph');
	const title = value.title === undefined ? undefined : checkText(value.title, GRAPH_LIMITS.title, 'title');
	if (!Array.isArray(value.nodes) || value.nodes.length === 0) throw new Error('nodes: must be a list with at least one node');
	if (value.nodes.length > GRAPH_LIMITS.nodes) throw new Error(`nodes: more than ${GRAPH_LIMITS.nodes} nodes`);
	const ids = new Set<string>();
	const nodes = value.nodes.map((item: unknown, i): GraphNode => {
		const where = `nodes[${i}]`;
		if (!isObject(item)) throw new Error(`${where}: must be an object`);
		checkKeys(item, ['id', 'label', 'size', 'color'], where);
		const id = item.id;
		if (typeof id !== 'string' || !NODE_ID_RE.test(id)) throw new Error(`${where}.id: must be 1 to 64 characters of letters, digits and _ . : -`);
		if (ids.has(id)) throw new Error(`${where}.id: duplicate id "${id}"`);
		ids.add(id);
		const label = item.label === undefined ? id : checkText(item.label, GRAPH_LIMITS.label, `${where}.label`) || id;
		const size = item.size === undefined ? 2 : item.size;
		if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > 5) throw new Error(`${where}.size: must be a whole number from 1 to 5`);
		const color = resolveColor(item.color === undefined ? 'blue' : item.color, `${where}.color`);
		return {id, label, size, color};
	});
	const edges = value.edges === undefined ? [] : checkEdgeList(ids, value.edges, 'edges');
	return {...(title !== undefined && title !== '' && {title}), nodes, edges};
}

export function parseGraphText(text: string): GraphInput {
	if (Buffer.byteLength(text) > GRAPH_LIMITS.inputBytes) throw new Error(`The graph is larger than ${GRAPH_LIMITS.inputBytes} bytes`);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error('The graph is not valid JSON');
	}
	return validateGraph(value);
}

export function formatEdge(edge: GraphEdge): string {
	const arrow = edge.kind === 'directed' ? '->' : edge.kind === 'bidirectional' ? '<->' : '--';
	return `${edge.from} ${arrow} ${edge.to}`;
}

const sameEdge = (a: GraphEdge, b: GraphEdge): boolean => a.kind === b.kind && (a.kind !== 'directed' || (a.from === b.from && a.to === b.to));

export function diffEdges(initial: readonly GraphEdge[], current: readonly GraphEdge[]): EdgeDiff {
	const before = new Map(initial.map(e => [pairKey(e.from, e.to), e]));
	const after = new Map(current.map(e => [pairKey(e.from, e.to), e]));
	const diff: EdgeDiff = {added: [], removed: [], changed: []};
	for (const [key, edge] of after) {
		const old = before.get(key);
		if (!old) diff.added.push(edge);
		else if (!sameEdge(old, edge)) diff.changed.push({before: old, after: edge});
	}
	for (const [key, edge] of before) if (!after.has(key)) diff.removed.push(edge);
	return diff;
}
