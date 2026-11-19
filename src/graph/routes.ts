import {readFile} from 'node:fs/promises';
import type {Logger} from '../../../../src/api.js';
import type {ModuleMessageResult} from '../deps/chat.js';
import type {WebRequest, WebResponse, WebRoute} from '../deps/web.js';
import {resultMessage} from './message.js';
import {checkEdges, diffEdges, GRAPH_LIMITS, type GraphEdge} from './schema.js';
import {GRAPH_ID_RE, StoreError, type GraphRecord, type GraphStore} from './store.js';

const ASSETS: Readonly<Record<string, {file: string; type: string}>> = Object.freeze({
	'graph.js': {file: 'graph.js', type: 'text/javascript; charset=utf-8'},
	'sim.js': {file: 'sim.js', type: 'text/javascript; charset=utf-8'},
	'graph.css': {file: 'graph.css', type: 'text/css; charset=utf-8'},
	'index.html': {file: 'index.html', type: 'text/html; charset=utf-8'},
});
const ASSET_DIR = new URL('../../assets/graph/', import.meta.url);
const JSON_TYPE = 'application/json; charset=utf-8';

export type RoutesDeps = {
	store: GraphStore;
	post: (text: string) => Promise<ModuleMessageResult>;
	log: Logger;
	readAsset?: (file: string) => Promise<string>;
};

const json = (status: number, body: unknown): WebResponse => ({status, type: JSON_TYPE, body: JSON.stringify(body)});
const notAllowed = (allow: string): WebResponse => ({status: 405, body: 'Method not allowed', headers: {Allow: allow}});
const fail = (status: number, message: string): WebResponse => json(status, {error: message});

export function createGraphRoutes(deps: RoutesDeps): WebRoute[] {
	const {store, post, log} = deps;
	const cache = new Map<string, string>();
	const readAsset = deps.readAsset ?? ((file: string) => readFile(new URL(file, ASSET_DIR), 'utf8'));

	const asset = async (name: string): Promise<WebResponse> => {
		const entry = Object.hasOwn(ASSETS, name) ? ASSETS[name] : undefined;
		if (!entry) return {status: 404, body: 'Not found'};
		let text = cache.get(entry.file);
		if (text === undefined) {
			try {
				text = await readAsset(entry.file);
			} catch (err) {
				log.warn('graph asset unreadable', {err});
				return {status: 500, body: 'Internal error'};
			}
			cache.set(entry.file, text);
		}
		return {status: 200, type: entry.type, body: text};
	};

	const data = (g: GraphRecord): WebResponse =>
		json(200, {id: g.id, title: g.title ?? null, interactive: g.interactive, finished: g.finishedAt !== undefined, nodes: g.nodes, edges: g.edges});

	const readEdges = (g: GraphRecord, req: WebRequest): GraphEdge[] | WebResponse => {
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(req.body));
		} catch {
			return fail(400, 'The body is not valid JSON');
		}
		if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== 1 || !('edges' in value)) {
			return fail(400, 'The body must be {"edges": [...]}');
		}
		try {
			return checkEdges(g.nodes, (value as {edges: unknown}).edges);
		} catch (err) {
			return fail(400, (err as Error).message);
		}
	};

	const storeFailure = (err: unknown): WebResponse => {
		if (err instanceof StoreError) {
			return fail(err.code === 'not-found' ? 404 : err.code === 'view-only' ? 403 : 409, err.message);
		}
		throw err;
	};

	const write = async (g: GraphRecord, action: 'edges' | 'done', req: WebRequest): Promise<WebResponse> => {
		const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
		if (type !== 'application/json') return fail(415, 'The body must be application/json');
		if (!g.interactive) return fail(403, 'This graph is view only');
		if (g.finishedAt !== undefined) return fail(409, 'The graph is finished');
		const edges = readEdges(g, req);
		if (!Array.isArray(edges)) return edges;
		try {
			if (action === 'edges') {
				await store.saveEdges(g.id, edges);
				return json(200, {ok: true});
			}
			const done = await store.finish(g.id, edges);
			let chat: ModuleMessageResult | 'refused';
			try {
				chat = await post(resultMessage(done, diffEdges(done.initialEdges, done.edges)));
			} catch (err) {
				chat = 'refused';
				log.warn('graph result not sent', {err});
			}
			return json(200, {ok: true, chat});
		} catch (err) {
			return storeFailure(err);
		}
	};

	const graph: WebRoute = {
		module: 'interact',
		endpoint: 'graph',
		methods: ['GET', 'POST'],
		prefix: true,
		maxBodyBytes: GRAPH_LIMITS.inputBytes,
		async handle(req) {
			const [id, action, ...more] = req.rest;
			if (id === undefined || !GRAPH_ID_RE.test(id) || more.length > 0) return {status: 404, body: 'No such graph'};
			const g = await store.read(id);
			if (!g) return {status: 404, body: 'No such graph'};
			if (req.method === 'GET') {
				if (action === undefined) return asset('index.html');
				if (action === 'data') return data(g);
				if (action === 'edges' || action === 'done') return notAllowed('POST');
				return {status: 404, body: 'Not found'};
			}
			if (action === 'edges' || action === 'done') return write(g, action, req);
			if (action === undefined || action === 'data') return notAllowed('GET');
			return {status: 404, body: 'Not found'};
		},
	};

	const assets: WebRoute = {
		module: 'interact',
		endpoint: 'assets',
		methods: ['GET'],
		prefix: true,
		async handle(req) {
			const [name, ...more] = req.rest;
			if (name === undefined || more.length > 0 || name === 'index.html') return {status: 404, body: 'Not found'};
			return asset(name);
		},
	};

	return [graph, assets];
}
