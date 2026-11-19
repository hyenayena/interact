import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, test} from 'node:test';
import {noopLog} from '../../src/log.js';
import {createGraphRoutes} from '../../src/graph/routes.js';
import {validateGraph} from '../../src/graph/schema.js';
import {createGraphStore} from '../../src/graph/store.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, {recursive: true, force: true})));

type Result = 'sent' | 'no-chat';

async function setup(post: (text: string) => Promise<Result> = async () => 'sent') {
	const dataDir = mkdtempSync(path.join(tmpdir(), 'interact-routes-'));
	dirs.push(dataDir);
	const store = createGraphStore({dataDir, log: noopLog});
	const posted: string[] = [];
	const reads: string[] = [];
	const [graph, assets] = createGraphRoutes({
		store,
		log: noopLog,
		post: async text => (posted.push(text), post(text)),
		readAsset: async file => (reads.push(file), `content of ${file}`),
	});
	const input = validateGraph({title: 'T', nodes: [{id: 'a'}, {id: 'b'}, {id: 'c'}], edges: [{from: 'a', to: 'b'}]});
	const call = (route: typeof graph, method: 'GET' | 'POST', rest: string[], body?: unknown, headers: Record<string, string> = {'content-type': 'application/json'}) =>
		route!.handle({method, module: 'interact', endpoint: route!.endpoint, rest, query: {}, headers, body: body === undefined ? new Uint8Array(0) : new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body))});
	return {store, posted, reads, graph: graph!, assets: assets!, input, call};
}

const parsed = (r: {body?: string | Uint8Array}) => JSON.parse(r.body as string);

test('the routes are interact/graph and interact/assets', async () => {
	const s = await setup();
	assert.deepEqual([s.graph, s.assets].map(r => [r.module, r.endpoint, r.methods, r.prefix]), [
		['interact', 'graph', ['GET', 'POST'], true],
		['interact', 'assets', ['GET'], true],
	]);
	assert.equal(s.graph.maxBodyBytes, 262144);
});

test('GET serves the page and the data of a graph', async () => {
	const s = await setup();
	const rec = await s.store.create(s.input, true);
	const page = await s.call(s.graph, 'GET', [rec.id]);
	assert.equal(page.status, 200);
	assert.match(page.type!, /^text\/html/);
	assert.equal(page.body, 'content of index.html');
	const data = await s.call(s.graph, 'GET', [rec.id, 'data']);
	assert.equal(data.status, 200);
	assert.match(data.type!, /^application\/json/);
	assert.deepEqual(parsed(data), {id: rec.id, title: 'T', interactive: true, finished: false, nodes: rec.nodes, edges: rec.edges});
});

test('unknown graphs and paths are 404', async () => {
	const s = await setup();
	const rec = await s.store.create(s.input, true);
	for (const rest of [[], ['AAAAAAAAAAAAAAAA'], ['AAAAAAAAAAAAAAAA', 'data'], ['short'], ['..'], [rec.id, 'nope'], [rec.id, 'data', 'more']]) {
		assert.equal((await s.call(s.graph, 'GET', rest)).status, 404, rest.join('/'));
	}
	assert.equal((await s.call(s.graph, 'POST', ['AAAAAAAAAAAAAAAA', 'edges'], {edges: []})).status, 404);
	assert.equal((await s.call(s.graph, 'POST', [rec.id, 'nope'], {edges: []})).status, 404);
});

test('the wrong method is 405', async () => {
	const s = await setup();
	const rec = await s.store.create(s.input, true);
	assert.equal((await s.call(s.graph, 'GET', [rec.id, 'edges'])).status, 405);
	assert.equal((await s.call(s.graph, 'POST', [rec.id, 'data'], {edges: []})).status, 405);
	assert.equal((await s.call(s.graph, 'POST', [rec.id], {edges: []})).status, 405);
});

test('a post needs the JSON media type', async () => {
	const s = await setup();
	const rec = await s.store.create(s.input, true);
	for (const headers of [{} as Record<string, string>, {'content-type': 'text/plain'}, {'content-type': 'application/x-www-form-urlencoded'}, {'content-type': 'application/jsonx'}]) {
		assert.equal((await s.call(s.graph, 'POST', [rec.id, 'edges'], {edges: []}, headers)).status, 415);
	}
	assert.equal((await s.call(s.graph, 'POST', [rec.id, 'edges'], {edges: []}, {'content-type': 'Application/JSON; charset=utf-8'})).status, 200);
});

test('a post body must be exactly {edges} and valid', async () => {
	const s = await setup();
	const rec = await s.store.create(s.input, true);
	for (const body of ['{nope', '[]', '{}', {edges: [], extra: 1}, {edges: 'x'}, {edges: [{from: 'a', to: 'zz'}]}, {edges: [{from: 'a', to: 'a'}]}, {edges: [{from: 'a', to: 'b'}, {from: 'b', to: 'a'}]}]) {
		const r = await s.call(s.graph, 'POST', [rec.id, 'edges'], body);
		assert.equal(r.status, 400, JSON.stringify(body));
		assert.equal(typeof parsed(r).error, 'string');
	}
	assert.deepEqual((await s.store.read(rec.id))?.edges, rec.edges);
	const invalidUtf8 = await s.graph.handle({method: 'POST', module: 'interact', endpoint: 'graph', rest: [rec.id, 'edges'], query: {}, headers: {'content-type': 'application/json'}, body: new Uint8Array([0x7b, 0xff, 0x7d])});
	assert.equal(invalidUtf8.status, 400);
});

test('edges are saved', async () => {
	const s = await setup();
	const rec = await s.store.create(s.input, true);
	const r = await s.call(s.graph, 'POST', [rec.id, 'edges'], {edges: [{from: 'b', to: 'c', kind: 'directed'}]});
	assert.equal(r.status, 200);
	assert.deepEqual(parsed(r), {ok: true});
	assert.deepEqual((await s.store.read(rec.id))?.edges, [{from: 'b', to: 'c', kind: 'directed'}]);
	assert.deepEqual(s.posted, []);
});

test('a view only graph is 403 and a finished one is 409', async () => {
	const s = await setup();
	const view = await s.store.create(s.input, false);
	assert.equal((await s.call(s.graph, 'POST', [view.id, 'edges'], {edges: []})).status, 403);
	assert.equal((await s.call(s.graph, 'POST', [view.id, 'done'], {edges: []})).status, 403);
	assert.equal(parsed(await s.call(s.graph, 'GET', [view.id, 'data'])).interactive, false);
	const rec = await s.store.create(s.input, true);
	await s.store.finish(rec.id, []);
	assert.equal((await s.call(s.graph, 'POST', [rec.id, 'edges'], {edges: []})).status, 409);
	assert.equal((await s.call(s.graph, 'POST', [rec.id, 'done'], {edges: []})).status, 409);
	assert.equal(parsed(await s.call(s.graph, 'GET', [rec.id, 'data'])).finished, true);
	assert.deepEqual(s.posted, []);
});

test('done saves, finishes and sends the result to the chat', async () => {
	const s = await setup();
	const rec = await s.store.create(s.input, true);
	const r = await s.call(s.graph, 'POST', [rec.id, 'done'], {edges: [{from: 'b', to: 'c', kind: 'plain'}]});
	assert.equal(r.status, 200);
	assert.deepEqual(parsed(r), {ok: true, chat: 'sent'});
	const after = await s.store.read(rec.id);
	assert.equal(typeof after?.finishedAt, 'number');
	assert.equal(s.posted.length, 1);
	assert.match(s.posted[0]!, new RegExp(`Done on graph ${rec.id} "T"`));
	assert.match(s.posted[0]!, /Added: b -- c/);
	assert.match(s.posted[0]!, /Removed: a -- b/);
	assert.equal((await s.call(s.graph, 'POST', [rec.id, 'done'], {edges: []})).status, 409);
	assert.equal(s.posted.length, 1);
});

test('done reports no-chat and refused', async () => {
	const none = await setup(async () => 'no-chat');
	const a = await none.store.create(none.input, true);
	assert.deepEqual(parsed(await none.call(none.graph, 'POST', [a.id, 'done'], {edges: []})), {ok: true, chat: 'no-chat'});
	const refused = await setup(async () => {
		throw new Error('API key only');
	});
	const b = await refused.store.create(refused.input, true);
	const r = await refused.call(refused.graph, 'POST', [b.id, 'done'], {edges: []});
	assert.equal(r.status, 200);
	assert.deepEqual(parsed(r), {ok: true, chat: 'refused'});
	assert.equal(typeof (await refused.store.read(b.id))?.finishedAt, 'number');
});

test('assets come from a fixed allowlist', async () => {
	const s = await setup();
	const types: Record<string, string> = {'graph.js': 'text/javascript', 'sim.js': 'text/javascript', 'graph.css': 'text/css'};
	for (const [name, type] of Object.entries(types)) {
		const r = await s.call(s.assets, 'GET', [name]);
		assert.equal(r.status, 200, name);
		assert.ok(r.type!.startsWith(type));
		assert.equal(r.body, `content of ${name}`);
	}
	await s.call(s.assets, 'GET', ['graph.js']);
	assert.equal(s.reads.filter(f => f === 'graph.js').length, 1);
	const before = s.reads.length;
	for (const rest of [[], ['..'], ['../../src/index.ts'], ['graph.js', 'x'], ['GRAPH.JS'], ['graph.js.map'], ['index.html'], ['package.json'], ['constructor'], ['__proto__'], ['%2e%2e'], ['graph.js\u0000']]) {
		assert.equal((await s.call(s.assets, 'GET', rest)).status, 404, rest.join('/'));
	}
	assert.equal(s.reads.length, before);
});

test('an unreadable asset is a plain 500', async () => {
	const dataDir = mkdtempSync(path.join(tmpdir(), 'interact-routes-'));
	dirs.push(dataDir);
	const [, assets] = createGraphRoutes({
		store: createGraphStore({dataDir, log: noopLog}),
		log: noopLog,
		post: async () => 'sent',
		readAsset: async () => {
			throw new Error('/secret/path');
		},
	});
	const r = await assets!.handle({method: 'GET', module: 'interact', endpoint: 'assets', rest: ['graph.js'], query: {}, headers: {}, body: new Uint8Array(0)});
	assert.equal(r.status, 500);
	assert.equal(r.body, 'Internal error');
});

test('the real assets exist', async () => {
	const dataDir = mkdtempSync(path.join(tmpdir(), 'interact-routes-'));
	dirs.push(dataDir);
	const [graph, assets] = createGraphRoutes({store: createGraphStore({dataDir, log: noopLog}), log: noopLog, post: async () => 'sent'});
	for (const name of ['graph.js', 'sim.js', 'graph.css']) {
		const r = await assets!.handle({method: 'GET', module: 'interact', endpoint: 'assets', rest: [name], query: {}, headers: {}, body: new Uint8Array(0)});
		assert.equal(r.status, 200, name);
		assert.ok(String(r.body).length > 100);
	}
	const store = createGraphStore({dataDir, log: noopLog});
	const [real] = createGraphRoutes({store, log: noopLog, post: async () => 'sent'});
	const rec = await store.create(validateGraph({nodes: [{id: 'a'}]}), false);
	const page = await real!.handle({method: 'GET', module: 'interact', endpoint: 'graph', rest: [rec.id], query: {}, headers: {}, body: new Uint8Array(0)});
	assert.match(String(page.body), /<canvas/);
	assert.ok(graph);
});

test('ids that fail the id pattern never reach the store', async () => {
	const s = await setup();
	let reads = 0;
	const original = s.store.read;
	s.store.read = async id => (reads++, original(id));
	for (const id of ['', '..', '../../etc/passwd', 'short', 'a'.repeat(17), 'a'.repeat(15) + '/', 'a'.repeat(15) + '.', '%2e%2e', 'a'.repeat(15) + '\u0000']) {
		for (const method of ['GET', 'POST'] as const) {
			assert.equal((await s.call(s.graph, method, [id, 'data'])).status, 404, id);
		}
	}
	assert.equal(reads, 0);
});

test('two concurrent done posts send to the chat once', async () => {
	const s = await setup();
	const rec = await s.store.create(s.input, true);
	const rs = await Promise.all([
		s.call(s.graph, 'POST', [rec.id, 'done'], {edges: []}),
		s.call(s.graph, 'POST', [rec.id, 'done'], {edges: []}),
	]);
	assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
	assert.equal(s.posted.length, 1);
});

test('a double-encoded dot in an asset name is just an unknown name', async () => {
	const s = await setup();
	const before = s.reads.length;
	for (const rest of [['%252e%252e'], ['%2e%2e%2fgraph.js'], ['graph.js%00'], ['..%2f']]) {
		assert.equal((await s.call(s.assets, 'GET', rest)).status, 404, rest.join('/'));
	}
	assert.equal(s.reads.length, before);
});

test('a malformed or oversize edge post never reaches the chat', async () => {
	const s = await setup();
	const rec = await s.store.create(s.input, true);
	for (const body of ['not json', '[]', '{"edges":[],"x":1}', '{"edges":[{"from":"a","to":"zzz"}]}']) {
		assert.equal((await s.call(s.graph, 'POST', [rec.id, 'done'], body)).status, 400, body);
	}
	assert.equal(s.posted.length, 0);
	assert.equal((await s.store.read(rec.id))?.finishedAt, undefined);
});
