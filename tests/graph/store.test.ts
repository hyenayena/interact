import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, test} from 'node:test';
import {noopLog} from '../../src/log.js';
import {COLORS, diffGraph, styleOf, validateGraph} from '../../src/graph/schema.js';
import {createGraphStore, KEEP_GRAPHS, StoreError} from '../../src/graph/store.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, {recursive: true, force: true})));

const make = (extra: Record<string, unknown> = {}) => {
	const dataDir = mkdtempSync(path.join(tmpdir(), 'interact-store-'));
	dirs.push(dataDir);
	let t = 1000;
	const warns: unknown[] = [];
	const log = {...noopLog, warn: (...a: unknown[]) => void warns.push(a)};
	const store = createGraphStore({dataDir, log, now: () => ++t, ...extra});
	return {dataDir, store, warns, graphs: path.join(dataDir, 'graphs')};
};

const input = () => validateGraph({title: 'T', nodes: [{id: 'a'}, {id: 'b'}, {id: 'c'}], edges: [{from: 'a', to: 'b'}]});

test('create writes a private file and read returns the record', async () => {
	const {store, graphs} = make();
	const rec = await store.create(input(), true);
	assert.match(rec.id, /^[A-Za-z0-9_-]{16}$/);
	assert.equal(statSync(graphs).mode & 0o777, 0o700);
	assert.equal(statSync(path.join(graphs, `${rec.id}.json`)).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(graphs), [`${rec.id}.json`]);
	assert.deepEqual(await store.read(rec.id), rec);
	assert.equal(rec.interactive, true);
	assert.deepEqual(rec.initialEdges, rec.edges);
});

test('save and finish change the record', async () => {
	const {store, graphs} = make();
	const rec = await store.create(input(), true);
	const saved = await store.save(rec.id, {edges: [{from: 'b', to: 'c', kind: 'directed'}]});
	assert.deepEqual(saved.edges, [{from: 'b', to: 'c', kind: 'directed'}]);
	assert.deepEqual(saved.initialEdges, rec.initialEdges);
	const done = await store.finish(rec.id, {edges: []});
	assert.equal(typeof done.finishedAt, 'number');
	assert.deepEqual((await store.read(rec.id))?.edges, []);
	await assert.rejects(store.save(rec.id, {edges: []}), (e: StoreError) => e.code === 'finished');
	await assert.rejects(store.finish(rec.id, {edges: []}), (e: StoreError) => e.code === 'finished');
	assert.equal(readdirSync(graphs).filter(f => f.endsWith('.tmp')).length, 0);
});

test('save applies styles and keeps the initial styles and labels', async () => {
	const {store} = make();
	const rec = await store.create(input(), true);
	assert.deepEqual(rec.initialStyles, [{id: 'a', color: COLORS.blue}, {id: 'b', color: COLORS.blue}, {id: 'c', color: COLORS.blue}]);
	const saved = await store.save(rec.id, {edges: [], styles: [{id: 'b', color: COLORS.red}]});
	assert.deepEqual(saved.nodes.map(n => [n.id, n.label, n.color]), [['a', 'a', COLORS.blue], ['b', 'b', COLORS.red], ['c', 'c', COLORS.blue]]);
	assert.deepEqual(saved.initialStyles, rec.initialStyles);
	const done = await store.finish(rec.id, {edges: [], styles: [{id: 'a', color: '#abc'}]});
	assert.deepEqual(done.nodes.map(n => n.color), ['#abc', COLORS.red, COLORS.blue]);
	assert.deepEqual(await store.read(rec.id), done);
});

test('a version 1 file reads as version 2 with the styles of its nodes', async () => {
	const {store, graphs} = make();
	mkdirSync(graphs, {recursive: true});
	const g = input();
	writeFileSync(path.join(graphs, 'AAAAAAAAAAAAAAAA.json'), JSON.stringify({v: 1, id: 'AAAAAAAAAAAAAAAA', interactive: true, createdAt: 1, updatedAt: 2, nodes: g.nodes.map(n => ({...n, size: 3})), initialEdges: g.edges, edges: g.edges}));
	const rec = await store.read('AAAAAAAAAAAAAAAA');
	assert.equal(rec?.v, 2);
	assert.deepEqual(rec?.nodes, g.nodes);
	assert.deepEqual(rec?.initialStyles, g.nodes.map(styleOf));
	assert.deepEqual(diffGraph(rec!).restyled, []);
});

test('a version 2 file with sizes (earlier 0.2.0) reads without them', async () => {
	const {store, graphs} = make();
	mkdirSync(graphs, {recursive: true});
	const g = input();
	const id = 'AAAAAAAAAAAAAAAA';
	const nodes = g.nodes.map(n => ({...n, size: 4}));
	nodes[1]!.color = COLORS.red;
	const initialStyles = g.nodes.map(n => ({id: n.id, size: 2, color: n.color}));
	writeFileSync(path.join(graphs, `${id}.json`), JSON.stringify({v: 2, id, interactive: true, createdAt: 1, updatedAt: 2, nodes, initialStyles, initialEdges: g.edges, edges: g.edges}));
	const rec = await store.read(id);
	assert.deepEqual(rec?.nodes.map(n => Object.keys(n)), g.nodes.map(() => ['id', 'label', 'color']));
	assert.deepEqual(rec?.initialStyles, g.nodes.map(styleOf));
	assert.deepEqual(diffGraph(rec!).restyled, [{id: 'b', before: {color: COLORS.blue}, after: {color: COLORS.red}}]);
	await store.save(id, {edges: g.edges});
	assert.doesNotMatch(readFileSync(path.join(graphs, `${id}.json`), 'utf8'), /"size"/);
});

const sized = (over: Record<string, unknown>) => {
	const g = input();
	return {v: 2, id: 'AAAAAAAAAAAAAAAA', interactive: true, createdAt: 1, updatedAt: 2, nodes: g.nodes, initialStyles: g.nodes.map(styleOf), initialEdges: g.edges, edges: g.edges, ...over};
};

test('a file that differs only by size equals the clean file and has an empty diff', async () => {
	const {store, graphs} = make();
	mkdirSync(graphs, {recursive: true});
	const g = input();
	const id = 'AAAAAAAAAAAAAAAA';
	writeFileSync(path.join(graphs, `${id}.json`), JSON.stringify(sized({})));
	const clean = await store.read(id);
	assert.ok(clean);
	writeFileSync(path.join(graphs, `${id}.json`), JSON.stringify(sized({nodes: g.nodes.map(n => ({...n, size: 9})), initialStyles: g.nodes.map(n => ({...styleOf(n), size: 1}))})));
	assert.deepEqual(await store.read(id), clean);
	assert.deepEqual(diffGraph((await store.read(id))!).restyled, []);
});

test('a stored item with size and an unknown key, or a stored __proto__ key, is corrupt', async () => {
	const {store, graphs, warns} = make();
	mkdirSync(graphs, {recursive: true});
	const g = input();
	const proto = JSON.parse('{"id":"a","label":"a","color":"#4c8dff","__proto__":{"x":1}}');
	const cases: Record<string, unknown>[] = [
		sized({nodes: g.nodes.map(n => ({...n, size: 3, extra: 1}))}),
		sized({initialStyles: g.nodes.map(n => ({...styleOf(n), size: 3, extra: 1}))}),
		sized({nodes: [{...proto, size: 2}, ...g.nodes.slice(1)]}),
		sized({nodes: [proto, ...g.nodes.slice(1)]}),
	];
	for (const [i, value] of cases.entries()) {
		const id = 'ABCD'[i]!.repeat(16);
		writeFileSync(path.join(graphs, `${id}.json`), JSON.stringify({...value, id}));
		assert.equal(await store.read(id), undefined, id);
	}
	assert.equal(warns.length, 4);
});

test('non-array or non-object nodes and styles are left for validation to refuse', async () => {
	const {store, graphs, warns} = make();
	mkdirSync(graphs, {recursive: true});
	const g = input();
	const cases: Record<string, unknown>[] = [
		sized({nodes: {size: 1}}),
		sized({nodes: 'size'}),
		sized({nodes: [null, ...g.nodes]}),
		sized({nodes: [[{size: 1}], ...g.nodes]}),
		sized({initialStyles: {size: 1}}),
		sized({initialStyles: [3, 4, 5]}),
	];
	for (const [i, value] of cases.entries()) {
		const id = 'ABCDEF'[i]!.repeat(16);
		writeFileSync(path.join(graphs, `${id}.json`), JSON.stringify({...value, id}));
		assert.equal(await store.read(id), undefined, id);
	}
	assert.equal(warns.length, 6);
});

test('a version 2 file with wrong initial styles, or version 3, is corrupt', async () => {
	const {store, graphs, warns} = make();
	mkdirSync(graphs, {recursive: true});
	const g = input();
	const base = {id: 'AAAAAAAAAAAAAAAA', interactive: true, createdAt: 1, updatedAt: 2, nodes: g.nodes, initialEdges: g.edges, edges: g.edges};
	const styles = g.nodes.map(styleOf);
	const cases: [string, Record<string, unknown>][] = [
		['AAAAAAAAAAAAAAAA', {...base, v: 2, initialStyles: styles.slice(1)}],
		['BBBBBBBBBBBBBBBB', {...base, id: 'BBBBBBBBBBBBBBBB', v: 2}],
		['CCCCCCCCCCCCCCCC', {...base, id: 'CCCCCCCCCCCCCCCC', v: 3, initialStyles: styles}],
	];
	for (const [id, value] of cases) {
		writeFileSync(path.join(graphs, `${id}.json`), JSON.stringify(value));
		assert.equal(await store.read(id), undefined, id);
	}
	assert.equal(warns.length, 3);
});

test('a view only graph cannot be edited and a missing one is not found', async () => {
	const {store} = make();
	const rec = await store.create(input(), false);
	await assert.rejects(store.save(rec.id, {edges: []}), (e: StoreError) => e.code === 'view-only');
	await assert.rejects(store.finish(rec.id, {edges: []}), (e: StoreError) => e.code === 'view-only');
	await assert.rejects(store.save('AAAAAAAAAAAAAAAA', {edges: []}), (e: StoreError) => e.code === 'not-found');
});

test('concurrent saves are applied one after the other', async () => {
	const {store} = make();
	const rec = await store.create(input(), true);
	await Promise.all([store.save(rec.id, {edges: []}), store.save(rec.id, {edges: [{from: 'a', to: 'c', kind: 'plain'}]}), store.finish(rec.id, {edges: []})]);
	assert.equal(typeof (await store.read(rec.id))?.finishedAt, 'number');
});

test('bad and traversal ids never reach the file system', async () => {
	const {store, dataDir} = make();
	for (const id of ['', '../../etc/passwd', '..', 'a'.repeat(15), 'a'.repeat(17), 'aaaaaaaaaaaaaaa/', 'aaaaaaaa/../aaaaa', 'aaaaaaaaaaaaaaa\u0000', 'aaaaaaaaaaaaaaa.']) {
		assert.equal(await store.read(id), undefined, id);
		await assert.rejects(store.save(id, {edges: []}), (e: StoreError) => e.code === 'not-found');
		await assert.rejects(store.finish(id, {edges: []}), (e: StoreError) => e.code === 'not-found');
	}
	assert.deepEqual(readdirSync(dataDir), []);
});

test('a corrupt or invalid file reads as missing and is logged', async () => {
	const {store, graphs, warns} = make();
	mkdirSync(graphs, {recursive: true});
	writeFileSync(path.join(graphs, 'AAAAAAAAAAAAAAAA.json'), '{not json');
	writeFileSync(path.join(graphs, 'BBBBBBBBBBBBBBBB.json'), JSON.stringify({v: 1, id: 'BBBBBBBBBBBBBBBB', nodes: [], edges: []}));
	writeFileSync(path.join(graphs, 'CCCCCCCCCCCCCCCC.json'), JSON.stringify({v: 1, id: 'DDDDDDDDDDDDDDDD'}));
	for (const id of ['AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCC', 'EEEEEEEEEEEEEEEE']) assert.equal(await store.read(id), undefined);
	assert.equal(warns.length, 3);
	assert.deepEqual(await store.list(), []);
});

test('list returns the newest first and create prunes to 100', async () => {
	const {store, graphs} = make();
	const first = await store.create(input(), false);
	for (let i = 0; i < KEEP_GRAPHS + 4; i++) {
		await store.create(input(), false);
		await new Promise(r => setTimeout(r, 2));
	}
	assert.equal(readdirSync(graphs).length, KEEP_GRAPHS);
	assert.equal(await store.read(first.id), undefined);
	const all = await store.list();
	assert.equal(all.length, KEEP_GRAPHS);
	for (let i = 1; i < all.length; i++) assert.ok(all[i - 1]!.createdAt >= all[i]!.createdAt);
});

test('list of an empty store is empty', async () => {
	assert.deepEqual(await make().store.list(), []);
});
