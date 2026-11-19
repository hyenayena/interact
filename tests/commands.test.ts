import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, test} from 'node:test';
import {createCommand} from '../src/commands.js';
import {noopLog} from '../src/log.js';
import {createGraphStore} from '../src/graph/store.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, {recursive: true, force: true})));

const tmp = () => {
	const d = mkdtempSync(path.join(tmpdir(), 'interact-cmd-'));
	dirs.push(d);
	return d;
};

function setup(over: {state?: string; baseUrl?: () => string; roots?: string[]} = {}) {
	const root = tmp();
	const data = path.join(root, 'data');
	const work = path.join(root, 'work');
	mkdirSync(work);
	const store = createGraphStore({dataDir: data, log: noopLog});
	const command = createCommand({
		store,
		log: noopLog,
		web: {baseUrl: over.baseUrl ?? (() => 'http://127.0.0.1:7300'), status: () => ({state: over.state ?? 'running'}) as never},
		fileRoots: over.roots ?? [work],
	});
	return {store, command, work, root};
}

const ctx = (extra: Record<string, unknown> = {}) => {
	const out: string[] = [];
	const help: (string[] | undefined)[] = [];
	return {
		out,
		help,
		value: {
			print: (t: string) => out.push(t),
			printStyled: (blocks: unknown[]) => out.push(JSON.stringify(blocks)),
			showHelp: (p?: string[]) => help.push(p),
			...extra,
		} as never,
	};
};

const kind = (k: string) => (e: Error & {kind?: string}) => e.kind === k;
const GRAPH = '{"title":"T","nodes":[{"id":"a"},{"id":"b"}],"edges":[{"from":"a","to":"b"}]}';

test('every node is safe', () => {
	const {command} = setup();
	assert.equal(command.agent, 'safe');
	const graph = command.subcommands!.find(s => s.name === 'graph')!;
	assert.equal(graph.agent, 'safe');
	assert.deepEqual(graph.subcommands!.map(s => [s.name, s.agent]), [['new', 'safe'], ['get', 'safe'], ['list', 'safe']]);
	assert.ok(graph.subcommands!.every(s => (s.notes ?? []).every(n => n.length < 200)));
});

test('no subcommand shows help, with a fallback', async () => {
	const {command} = setup();
	const c = ctx();
	await command.run([], c.value);
	assert.deepEqual(c.help, [undefined]);
	const f = ctx({showHelp: undefined});
	await command.run([], f.value);
	assert.deepEqual(f.out, ['interact <subcommand>']);
});

test('graph alone shows the help of graph', async () => {
	const {command} = setup();
	const c = ctx();
	await command.run(['graph'], c.value);
	assert.deepEqual(c.help, [['graph']]);
	const f = ctx({showHelp: undefined});
	await command.run(['graph'], f.value);
	assert.deepEqual(f.out, ['interact graph <subcommand>']);
});

test('unknown subcommands are usage errors', async () => {
	const {command} = setup();
	await assert.rejects(async () => command.run(['nope'], ctx().value), kind('usage'));
	await assert.rejects(async () => command.run(['graph', 'nope'], ctx().value), kind('usage'));
	await assert.rejects(async () => command.run(['graph', 'list', 'x'], ctx().value), kind('usage'));
});

test('new makes a view only graph from inline JSON', async () => {
	const {command, store} = setup();
	const c = ctx();
	await command.run(['graph', 'new', GRAPH], c.value);
	const [rec] = await store.list();
	assert.equal(rec!.interactive, false);
	assert.equal(c.out[0], `Graph ${rec!.id} (view only): 2 nodes, 1 edges`);
	assert.equal(c.out[1], `Open: http://127.0.0.1:7300/interact/graph/${rec!.id}`);
	assert.equal(c.out.length, 2);
});

test('new --interactive says where the result goes', async () => {
	const {command, store} = setup({state: 'stopped'});
	const c = ctx();
	await command.run(['graph', 'new', '--interactive', GRAPH], c.value);
	const [rec] = await store.list();
	assert.equal(rec!.interactive, true);
	assert.match(c.out[0]!, /\(interactive\)/);
	assert.match(c.out[2]!, /result goes to the open chat \(API key chats\).*interact graph get /);
	assert.match(c.out[3]!, /not running in this process/);
});

test('new survives an unavailable web address', async () => {
	const {command} = setup({
		baseUrl: () => {
			throw new Error('The web module is not loaded');
		},
	});
	const c = ctx();
	await command.run(['graph', 'new', GRAPH], c.value);
	assert.match(c.out[1]!, /^Open: \(the web server address is not available\)/);
});

test('new refuses extra words and asks to quote the JSON', async () => {
	const {command} = setup();
	await assert.rejects(async () => command.run(['graph', 'new', '{"nodes":', '[]}'], ctx().value), (e: Error & {kind?: string}) => e.kind === 'usage' && /quote the JSON/.test(e.message));
	await assert.rejects(async () => command.run(['graph', 'new'], ctx().value), kind('usage'));
	await assert.rejects(async () => command.run(['graph', 'new', '--file'], ctx().value), kind('usage'));
	await assert.rejects(async () => command.run(['graph', 'new', '--bogus', GRAPH], ctx().value), kind('usage'));
	await assert.rejects(async () => command.run(['graph', 'new', '--file', 'x', GRAPH], ctx().value), kind('usage'));
});

test('new reports invalid graphs with the invalid kind', async () => {
	const {command} = setup();
	await assert.rejects(async () => command.run(['graph', 'new', '{"nodes":[]}'], ctx().value), (e: Error & {kind?: string}) => e.kind === 'invalid' && /at least one node/.test(e.message));
	await assert.rejects(async () => command.run(['graph', 'new', 'not json'], ctx().value), (e: Error & {kind?: string}) => e.kind === 'invalid' && e.message === 'The graph is not valid JSON');
});

test('new --file reads a file under the allowed roots', async () => {
	const {command, work, store} = setup();
	const file = path.join(work, 'g.json');
	writeFileSync(file, GRAPH);
	const c = ctx();
	await command.run(['graph', 'new', '--file', file], c.value);
	assert.equal((await store.list()).length, 1);
	assert.match(c.out[0]!, /2 nodes, 1 edges/);
});

test('new --file refuses files outside the roots, links out of them, big and special files', async () => {
	const {command, work, root} = setup();
	const outside = path.join(root, 'outside.json');
	writeFileSync(outside, GRAPH);
	await assert.rejects(async () => command.run(['graph', 'new', '--file', outside], ctx().value), (e: Error & {kind?: string}) => e.kind === 'invalid' && /must be under/.test(e.message));
	const link = path.join(work, 'link.json');
	symlinkSync(outside, link);
	await assert.rejects(async () => command.run(['graph', 'new', '--file', link], ctx().value), kind('invalid'));
	await assert.rejects(async () => command.run(['graph', 'new', '--file', path.join(work, '..', 'outside.json')], ctx().value), kind('invalid'));
	await assert.rejects(async () => command.run(['graph', 'new', '--file', path.join(work, 'missing.json')], ctx().value), kind('invalid'));
	await assert.rejects(async () => command.run(['graph', 'new', '--file', work], ctx().value), kind('invalid'));
	const big = path.join(work, 'big.json');
	writeFileSync(big, ' '.repeat(262145));
	await assert.rejects(async () => command.run(['graph', 'new', '--file', big], ctx().value), (e: Error & {kind?: string}) => e.kind === 'invalid' && /larger than 262144/.test(e.message));
});

test('a bad file never has its content echoed', async () => {
	const {command, work} = setup();
	const file = path.join(work, 'bad.json');
	writeFileSync(file, '{"secret-token-xyz": oops');
	await assert.rejects(
		async () => command.run(['graph', 'new', '--file', file], ctx().value),
		(e: Error & {kind?: string}) => e.kind === 'invalid' && !e.message.includes('secret-token-xyz') && !e.message.includes('oops'),
	);
	writeFileSync(file, '{"secret-token-xyz": 1, "nodes": [{"id": "a"}]}');
	await assert.rejects(async () => command.run(['graph', 'new', '--file', file], ctx().value), (e: Error) => !e.message.includes('secret-token-xyz'));
});

test('get prints the graph and the changes', async () => {
	const { command, store } = setup();
	const rec = await store.create({title: 'T', nodes: [{id: 'a', label: 'Alpha', size: 2, color: '#fff'}, {id: 'b', label: 'b', size: 2, color: '#fff'}, {id: 'c', label: 'c', size: 2, color: '#fff'}], edges: [{from: 'a', to: 'b', kind: 'plain'}]}, true);
	await store.finish(rec.id, [{from: 'b', to: 'c', kind: 'directed'}]);
	const c = ctx();
	await command.run(['graph', 'get', rec.id], c.value);
	const text = c.out.join('\n');
	assert.match(text, /^Graph .* "T": finished at \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
	assert.match(text, /  a: Alpha/);
	assert.match(text, /Edges \(1\):\n  b -> c/);
	assert.match(text, /Added: b -> c/);
	assert.match(text, /Removed: a -- b/);
	assert.match(text, /Changed: \(none\)/);
});

test('get --json prints the stored record without the version, plus the diff', async () => {
	const {command, store} = setup();
	const rec = await store.create({nodes: [{id: 'a', label: 'a', size: 2, color: '#fff'}], edges: []}, false);
	const c = ctx();
	await command.run(['graph', 'get', rec.id, '--json'], c.value);
	assert.equal(c.out.length, 1);
	const json = JSON.parse(c.out[0]!);
	assert.equal('v' in json, false);
	assert.equal(json.id, rec.id);
	assert.deepEqual(json.diff, {added: [], removed: [], changed: []});
	const v = ctx();
	await command.run(['graph', 'get', '--json', rec.id], v.value);
	assert.equal(v.out.length, 1);
});

test('get states view only graphs and refuses unknown or malformed ids', async () => {
	const {command, store} = setup();
	const rec = await store.create({nodes: [{id: 'a', label: 'a', size: 2, color: '#fff'}], edges: []}, false);
	const c = ctx();
	await command.run(['graph', 'get', rec.id], c.value);
	assert.match(c.out[0]!, /: view only$/);
	await assert.rejects(async () => command.run(['graph', 'get', 'AAAAAAAAAAAAAAAA'], ctx().value), kind('not-found'));
	await assert.rejects(async () => command.run(['graph', 'get', '../etc/passwd'], ctx().value), kind('invalid'));
	await assert.rejects(async () => command.run(['graph', 'get'], ctx().value), kind('usage'));
	await assert.rejects(async () => command.run(['graph', 'get', rec.id, 'x'], ctx().value), kind('usage'));
	await assert.rejects(async () => command.run(['graph', 'get', rec.id, '--nope'], ctx().value), kind('usage'));
});

test('list is empty or a table', async () => {
	const { command, store } = setup();
	const empty = ctx();
	await command.run(['graph', 'list'], empty.value);
	assert.deepEqual(empty.out, ['No graphs yet.']);
	await store.create({title: 'x'.repeat(100), nodes: [{id: 'a', label: 'a', size: 2, color: '#fff'}], edges: []}, true);
	const c = ctx();
	await command.run(['graph', 'list'], c.value);
	const blocks = JSON.parse(c.out[0]!);
	assert.equal(blocks[0].kind, 'table');
	assert.deepEqual(blocks[0].head, ['Id', 'Title', 'Mode', 'State', 'Nodes', 'Edges', 'Created']);
	assert.equal(blocks[0].rows.length, 1);
	assert.equal(blocks[0].rows[0][1].length, 40);
	assert.deepEqual(blocks[0].rows[0].slice(2, 6), ['interactive', 'open', '1', '0']);
});
