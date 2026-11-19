import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, test} from 'node:test';
import {noopLog} from '../../src/log.js';
import {validateGraph} from '../../src/graph/schema.js';
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

test('saveEdges and finish change the record', async () => {
	const {store, graphs} = make();
	const rec = await store.create(input(), true);
	const saved = await store.saveEdges(rec.id, [{from: 'b', to: 'c', kind: 'directed'}]);
	assert.deepEqual(saved.edges, [{from: 'b', to: 'c', kind: 'directed'}]);
	assert.deepEqual(saved.initialEdges, rec.initialEdges);
	const done = await store.finish(rec.id, []);
	assert.equal(typeof done.finishedAt, 'number');
	assert.deepEqual((await store.read(rec.id))?.edges, []);
	await assert.rejects(store.saveEdges(rec.id, []), (e: StoreError) => e.code === 'finished');
	await assert.rejects(store.finish(rec.id, []), (e: StoreError) => e.code === 'finished');
	assert.equal(readdirSync(graphs).filter(f => f.endsWith('.tmp')).length, 0);
});

test('a view only graph cannot be edited and a missing one is not found', async () => {
	const {store} = make();
	const rec = await store.create(input(), false);
	await assert.rejects(store.saveEdges(rec.id, []), (e: StoreError) => e.code === 'view-only');
	await assert.rejects(store.finish(rec.id, []), (e: StoreError) => e.code === 'view-only');
	await assert.rejects(store.saveEdges('AAAAAAAAAAAAAAAA', []), (e: StoreError) => e.code === 'not-found');
});

test('concurrent saves are applied one after the other', async () => {
	const {store} = make();
	const rec = await store.create(input(), true);
	await Promise.all([store.saveEdges(rec.id, []), store.saveEdges(rec.id, [{from: 'a', to: 'c', kind: 'plain'}]), store.finish(rec.id, [])]);
	assert.equal(typeof (await store.read(rec.id))?.finishedAt, 'number');
});

test('bad and traversal ids never reach the file system', async () => {
	const {store, dataDir} = make();
	for (const id of ['', '../../etc/passwd', '..', 'a'.repeat(15), 'a'.repeat(17), 'aaaaaaaaaaaaaaa/', 'aaaaaaaa/../aaaaa', 'aaaaaaaaaaaaaaa\u0000', 'aaaaaaaaaaaaaaa.']) {
		assert.equal(await store.read(id), undefined, id);
		await assert.rejects(store.saveEdges(id, []), (e: StoreError) => e.code === 'not-found');
		await assert.rejects(store.finish(id, []), (e: StoreError) => e.code === 'not-found');
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
