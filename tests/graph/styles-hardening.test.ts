import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, test} from 'node:test';
import {noopLog} from '../../src/log.js';
import {createGraphRoutes} from '../../src/graph/routes.js';
import {checkChange, COLORS, GRAPH_LIMITS, validateGraph} from '../../src/graph/schema.js';
import {createGraphStore} from '../../src/graph/store.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, {recursive: true, force: true})));

const input = () => validateGraph({title: 'T', nodes: [{id: 'a'}, {id: 'b'}, {id: 'c'}], edges: [{from: 'a', to: 'b'}]});

async function setup() {
	const dataDir = mkdtempSync(path.join(tmpdir(), 'interact-harden-'));
	dirs.push(dataDir);
	const mk = () => createGraphStore({dataDir, log: noopLog});
	const store = mk();
	const posted: string[] = [];
	const [graph] = createGraphRoutes({store, log: noopLog, post: async text => (posted.push(text), 'sent' as const), readAsset: async f => f});
	const post = (id: string, action: string, body: unknown) =>
		graph!.handle({method: 'POST', module: 'interact', endpoint: 'graph', rest: [id, action], query: {}, headers: {'content-type': 'application/json'}, body: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body))});
	return {dataDir, store, mk, posted, post};
}

const style = (id: string, color: unknown = 'red') => ({id, color});

test('a styles list longer than the node limit is refused', () => {
	const nodes = Array.from({length: GRAPH_LIMITS.nodes}, (_, i) => ({id: `n${i}`}));
	const many = Array.from({length: GRAPH_LIMITS.nodes + 1}, (_, i) => style(`n${i % GRAPH_LIMITS.nodes}`));
	assert.throws(() => checkChange(nodes, {edges: [], nodes: many}), /more than 500/);
	const unique = nodes.map(n => style(n.id));
	assert.equal(checkChange(nodes, {edges: [], nodes: unique}).styles?.length, GRAPH_LIMITS.nodes);
});

test('non-list nodes values are refused', () => {
	const g = input();
	for (const value of [null, {}, {a: 1}, 'a', 1, true, [null], [[]], ['a'], [1]]) {
		assert.throws(() => checkChange(g.nodes, {edges: [], nodes: value}), /nodes/, JSON.stringify(value));
	}
});

test('colors with control characters or CSS injection are refused without echo', () => {
	const g = input();
	const bad = ['red;background:url(x)', 'red\n', '#fff;', '#ggg', '#12', '#1234567', 'url(x)', ' red', 'RED', '#fff\u0000', 'red‮', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 7, null, ['red'], {}];
	for (const color of bad) {
		assert.throws(
			() => checkChange(g.nodes, {edges: [], nodes: [style('a', color)]}),
			(e: Error) => /color/.test(e.message) && !/url|background|\u0000|‮/.test(e.message),
			JSON.stringify(color),
		);
	}
});

test('a size key in a style is refused as an unknown key, not echoed', () => {
	const g = input();
	for (const size of [0, 2, 6, 2.5, '3', null, [3]]) {
		assert.throws(() => checkChange(g.nodes, {edges: [], nodes: [{id: 'a', color: 'red', size}]}), (e: Error) => /nodes\[0\]: unknown key$/.test(e.message) && !/size/.test(e.message), String(size));
	}
});

test('__proto__ and constructor keys in the body or in node items are refused', async () => {
	const s = await setup();
	const rec = await s.store.create(input(), true);
	const bodies = [
		'{"edges":[],"__proto__":{"x":1}}',
		'{"edges":[],"constructor":{}}',
		'{"edges":[],"nodes":[{"id":"a","color":"red","__proto__":{"color":"x"}}]}',
		'{"edges":[],"nodes":[{"id":"a","color":"red","constructor":1}]}',
		'{"edges":[],"nodes":[{"id":"__proto__","color":"red"}]}',
		'{"edges":[],"nodes":[{"id":"constructor","color":"red"}]}',
		'{"edges":[{"from":"a","to":"b","__proto__":{}}],"nodes":[]}',
	];
	for (const body of bodies) {
		for (const action of ['edges', 'done']) {
			const r = await s.post(rec.id, action, body);
			assert.equal(r.status, 400, body);
			if (!body.includes('"id":"')) assert.doesNotMatch(r.body as string, /__proto__|constructor/, body);
			else if (body.includes('"id":"a"')) assert.doesNotMatch(r.body as string, /__proto__|constructor/, body);
		}
	}
	assert.deepEqual(await s.store.read(rec.id), rec);
	assert.equal(({} as Record<string, unknown>).color, undefined);
	assert.deepEqual(s.posted, []);
});

test('a refused label key is not echoed', async () => {
	const s = await setup();
	const rec = await s.store.create(input(), true);
	const r = await s.post(rec.id, 'edges', {edges: [], nodes: [{id: 'a', color: 'red', label: 'SECRET-LABEL<script>'}]});
	assert.equal(r.status, 400);
	assert.doesNotMatch(r.body as string, /SECRET-LABEL|script/);
});

test('a nodes only change on a view only graph is 403 and nothing is written', async () => {
	const s = await setup();
	const view = await s.store.create(input(), false);
	const r = await s.post(view.id, 'edges', {edges: view.edges, nodes: [style('a')]});
	assert.equal(r.status, 403);
	assert.deepEqual(await s.mk().read(view.id), view);
});

test('styles persist across a reread from disk with a fresh store', async () => {
	const s = await setup();
	const rec = await s.store.create(input(), true);
	assert.equal((await s.post(rec.id, 'edges', {edges: rec.edges, nodes: [style('a', '#ABC')]})).status, 200);
	const fresh = await s.mk().read(rec.id);
	assert.deepEqual(fresh?.nodes.find(n => n.id === 'a'), {id: 'a', label: 'a', color: '#abc'});
	assert.deepEqual(fresh?.initialStyles, rec.initialStyles);
});

test('a version 1 file with a styles change is saved as version 2 and reread', async () => {
	const s = await setup();
	const graphs = path.join(s.dataDir, 'graphs');
	mkdirSync(graphs, {recursive: true});
	const g = input();
	const id = 'AAAAAAAAAAAAAAAA';
	writeFileSync(path.join(graphs, `${id}.json`), JSON.stringify({v: 1, id, interactive: true, createdAt: 1, updatedAt: 2, nodes: g.nodes, initialEdges: g.edges, edges: g.edges}));
	assert.equal((await s.post(id, 'edges', {edges: g.edges, nodes: [style('b', 'green')]})).status, 200);
	const raw = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(graphs, `${id}.json`), 'utf8'));
	assert.equal(raw.v, 2);
	const again = await s.mk().read(id);
	assert.deepEqual(again?.nodes.find(n => n.id === 'b')?.color, COLORS.green);
	assert.deepEqual(again?.initialStyles.find(n => n.id === 'b'), {id: 'b', color: COLORS.blue});
	assert.equal((await s.post(id, 'done', {edges: g.edges})).status, 200);
	assert.match(s.posted[0]!, /Restyled: b: color blue -> green/);
});

test('concurrent styles saves and done keep the styles and finish once', async () => {
	const s = await setup();
	const rec = await s.store.create(input(), true);
	const results = await Promise.all([
		s.post(rec.id, 'edges', {edges: rec.edges, nodes: [style('a', 'red')]}),
		s.post(rec.id, 'edges', {edges: rec.edges, nodes: [style('b', 'green')]}),
		s.post(rec.id, 'done', {edges: rec.edges, nodes: [style('c', 'pink')]}),
		s.post(rec.id, 'edges', {edges: rec.edges, nodes: [style('a', 'teal')]}),
	]);
	// The requests enter the store lock in the order their reads finish, so only the outcome per request is fixed.
	const [red, green, done, teal] = results.map(r => r.status);
	assert.equal(done, 200);
	for (const status of [red, green, teal]) assert.ok(status === 200 || status === 409, String(status));
	const final = await s.mk().read(rec.id);
	assert.equal(typeof final?.finishedAt, 'number');
	const by = Object.fromEntries(final!.nodes.map(n => [n.id, n.color]));
	const initialA = rec.nodes.find(n => n.id === 'a')!.color;
	const allowedA = [
		...(red === 200 ? [COLORS.red] : []),
		...(teal === 200 ? [COLORS.teal] : []),
		...(red !== 200 && teal !== 200 ? [initialA] : []),
	];
	assert.ok(allowedA.includes(by.a!), String(by.a));
	if (green === 200) assert.equal(by.b, COLORS.green);
	assert.equal(by.c, COLORS.pink);
	assert.equal(s.posted.length, 1);
});
