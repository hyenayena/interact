import {randomBytes} from 'node:crypto';
import {mkdir, readdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {Logger} from '../../../../src/api.js';
import {applyStyles, checkEdges, checkNodeStyles, styleOf, validateGraph, type GraphChange, type GraphEdge, type GraphInput, type GraphNode, type NodeStyle} from './schema.js';

export const GRAPH_ID_RE = /^[A-Za-z0-9_-]{16}$/;
export const KEEP_GRAPHS = 100;

export type GraphRecord = {
	v: 2;
	id: string;
	title?: string;
	interactive: boolean;
	createdAt: number;
	updatedAt: number;
	finishedAt?: number;
	nodes: GraphNode[];
	initialStyles: NodeStyle[];
	initialEdges: GraphEdge[];
	edges: GraphEdge[];
};

export type StoreErrorCode = 'not-found' | 'view-only' | 'finished';

export class StoreError extends Error {
	constructor(readonly code: StoreErrorCode, message: string) {
		super(message);
		this.name = 'StoreError';
	}
}

export type GraphStore = {
	create(input: GraphInput, interactive: boolean): Promise<GraphRecord>;
	read(id: string): Promise<GraphRecord | undefined>;
	list(): Promise<GraphRecord[]>;
	save(id: string, change: GraphChange): Promise<GraphRecord>;
	finish(id: string, change: GraphChange): Promise<GraphRecord>;
};

export type StoreOptions = {dataDir: string; log: Logger; now?: () => number; random?: (size: number) => Buffer};

const FILE_RE = /^([A-Za-z0-9_-]{16})\.json$/;

export function createGraphStore(options: StoreOptions): GraphStore {
	const {log} = options;
	const now = options.now ?? Date.now;
	const random = options.random ?? randomBytes;
	const dir = path.join(options.dataDir, 'graphs');
	const locks = new Map<string, Promise<unknown>>();

	const fileOf = (id: string): string => {
		if (!GRAPH_ID_RE.test(id)) throw new StoreError('not-found', 'No such graph');
		return path.join(dir, `${id}.json`);
	};

	const write = async (record: GraphRecord): Promise<void> => {
		await mkdir(dir, {recursive: true, mode: 0o700});
		const target = fileOf(record.id);
		const temp = `${target}.${random(6).toString('hex')}.tmp`;
		try {
			await writeFile(temp, JSON.stringify(record), {mode: 0o600, flag: 'wx'});
			await rename(temp, target);
		} catch (err) {
			await rm(temp, {force: true});
			throw err;
		}
	};

	const read = async (id: string): Promise<GraphRecord | undefined> => {
		if (!GRAPH_ID_RE.test(id)) return undefined;
		let text: string;
		try {
			text = await readFile(fileOf(id), 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('graph unreadable', {err});
			return undefined;
		}
		try {
			return parseRecord(id, JSON.parse(text));
		} catch (err) {
			log.warn('graph file is corrupt', {err});
			return undefined;
		}
	};

	const exclusive = async <T>(id: string, work: () => Promise<T>): Promise<T> => {
		const previous = locks.get(id) ?? Promise.resolve();
		const run = previous.then(work, work);
		const tail = run.catch(() => undefined);
		locks.set(id, tail);
		try {
			return await run;
		} finally {
			if (locks.get(id) === tail) locks.delete(id);
		}
	};

	const files = async (): Promise<{id: string; mtime: number}[]> => {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return [];
		}
		const out: {id: string; mtime: number}[] = [];
		for (const name of names) {
			const id = FILE_RE.exec(name)?.[1];
			if (!id) continue;
			try {
				out.push({id, mtime: (await stat(path.join(dir, name))).mtimeMs});
			} catch {
				continue;
			}
		}
		return out.sort((a, b) => b.mtime - a.mtime);
	};

	const prune = async (): Promise<void> => {
		const old = (await files()).slice(KEEP_GRAPHS - 1);
		for (const {id} of old) await rm(fileOf(id), {force: true});
		if (old.length > 0) log.info('old graphs removed', {count: old.length});
	};

	const editable = async (id: string): Promise<GraphRecord> => {
		const record = await read(id);
		if (!record) throw new StoreError('not-found', 'No such graph');
		if (!record.interactive) throw new StoreError('view-only', 'This graph is view only');
		if (record.finishedAt !== undefined) throw new StoreError('finished', 'The graph is finished');
		return record;
	};

	return {
		read,
		async create(input, interactive) {
			await prune();
			const id = random(12).toString('base64url');
			const at = now();
			const record: GraphRecord = {
				v: 2,
				id,
				...(input.title !== undefined && {title: input.title}),
				interactive,
				createdAt: at,
				updatedAt: at,
				nodes: input.nodes,
				initialStyles: input.nodes.map(styleOf),
				initialEdges: input.edges,
				edges: input.edges,
			};
			await write(record);
			log.info('graph created', {nodes: record.nodes.length, edges: record.edges.length, interactive});
			return record;
		},
		async list() {
			const out: GraphRecord[] = [];
			for (const {id} of (await files()).slice(0, KEEP_GRAPHS)) {
				const record = await read(id);
				if (record) out.push(record);
			}
			return out.sort((a, b) => b.createdAt - a.createdAt);
		},
		save(id, change) {
			return exclusive(id, async () => {
				const record = await editable(id);
				const next = {...record, nodes: applyStyles(record.nodes, change.styles), edges: change.edges, updatedAt: now()};
				await write(next);
				return next;
			});
		},
		finish(id, change) {
			return exclusive(id, async () => {
				const record = await editable(id);
				const at = now();
				const next = {...record, nodes: applyStyles(record.nodes, change.styles), edges: change.edges, updatedAt: at, finishedAt: at};
				await write(next);
				log.info('graph finished', {edges: change.edges.length, restyled: change.styles?.length ?? 0});
				return next;
			});
		},
	};
}

// Files from earlier versions carry a per-node size; it is dropped before validation.
function dropSize(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.map(item => {
		if (typeof item !== 'object' || item === null || Array.isArray(item) || !Object.hasOwn(item, 'size')) return item;
		const {size: _size, ...rest} = item as Record<string, unknown>;
		return rest;
	});
}

function parseRecord(id: string, value: unknown): GraphRecord {
	if (typeof value !== 'object' || value === null) throw new Error('not an object');
	const raw = value as Record<string, unknown>;
	if ((raw.v !== 1 && raw.v !== 2) || raw.id !== id) throw new Error('wrong version or id');
	const graph = validateGraph({title: raw.title, nodes: dropSize(raw.nodes), edges: raw.edges});
	const initialEdges = checkEdges(graph.nodes, raw.initialEdges);
	let initialStyles: NodeStyle[];
	if (raw.v === 1) initialStyles = graph.nodes.map(styleOf);
	else {
		initialStyles = checkNodeStyles(graph.nodes, dropSize(raw.initialStyles), 'initialStyles');
		if (initialStyles.length !== graph.nodes.length) throw new Error('bad initialStyles');
	}
	for (const key of ['createdAt', 'updatedAt'] as const) if (typeof raw[key] !== 'number') throw new Error(`bad ${key}`);
	if (typeof raw.interactive !== 'boolean') throw new Error('bad interactive');
	if (raw.finishedAt !== undefined && typeof raw.finishedAt !== 'number') throw new Error('bad finishedAt');
	return {
		v: 2,
		id,
		...(graph.title !== undefined && {title: graph.title}),
		interactive: raw.interactive,
		createdAt: raw.createdAt as number,
		updatedAt: raw.updatedAt as number,
		...(raw.finishedAt !== undefined && {finishedAt: raw.finishedAt as number}),
		nodes: graph.nodes,
		initialStyles,
		initialEdges,
		edges: graph.edges,
	};
}
