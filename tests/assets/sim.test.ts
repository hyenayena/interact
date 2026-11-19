import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {test} from 'node:test';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/graph/sim.js');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sim: any = await import(pathToFileURL(file).href);

const node = (id: string, size = 2) => ({id, size});
const dist = (s: any, a: string, b: string): number => {
	const p = s.index.get(a);
	const q = s.index.get(b);
	return Math.hypot(p.x - q.x, p.y - q.y);
};
const settle = (s: any, max = 400): number => {
	let ticks = 0;
	while (ticks < max && sim.tick(s)) ticks++;
	return ticks;
};

test('the initial layout is finite and spread out', () => {
	const s = sim.createSim(Array.from({length: 30}, (_, i) => node(`n${i}`)), []);
	assert.equal(s.nodes.length, 30);
	assert.ok(s.nodes.every((n: any) => Number.isFinite(n.x) && Number.isFinite(n.y)));
	assert.equal(new Set(s.nodes.map((n: any) => `${n.x.toFixed(3)},${n.y.toFixed(3)}`)).size, 30);
});

test('node radius follows the size', () => {
	assert.deepEqual([1, 2, 3, 4, 5].map(sim.radiusOf), [5, 7, 10, 14, 19]);
});

test('a connected pair ends closer than an unconnected pair', () => {
	const nodes = ['a', 'b', 'c', 'd'].map(id => node(id));
	const s = sim.createSim(nodes, [{from: 'a', to: 'b'}]);
	const start = {a: [-300, -40], b: [300, -40], c: [-300, 40], d: [300, 40]} as Record<string, number[]>;
	for (const [id, [x, y]] of Object.entries(start)) Object.assign(s.index.get(id), {x, y});
	settle(s);
	assert.ok(dist(s, 'a', 'b') < dist(s, 'c', 'd'), `${dist(s, 'a', 'b')} vs ${dist(s, 'c', 'd')}`);
	assert.ok(dist(s, 'a', 'b') < 600);
});

test('coincident nodes produce no NaN', () => {
	const s = sim.createSim([node('a'), node('b'), node('c')], [{from: 'a', to: 'b'}]);
	for (const n of s.nodes) Object.assign(n, {x: 5, y: 5});
	settle(s);
	assert.ok(s.nodes.every((n: any) => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.vx)));
	assert.ok(dist(s, 'a', 'c') > 0);
});

test('a pinned node stays where it is and unpinning frees it', () => {
	const s = sim.createSim([node('a'), node('b')], [{from: 'a', to: 'b'}]);
	sim.pin(s, 'a', 400, 400);
	for (let i = 0; i < 100; i++) sim.tick(s);
	const a = s.index.get('a');
	assert.deepEqual([a.x, a.y], [400, 400]);
	assert.ok(sim.isActive(s));
	sim.unpin(s, 'a');
	assert.equal(s.target, 0);
	for (let i = 0; i < 100; i++) sim.tick(s);
	assert.ok(Math.hypot(a.x - 400, a.y - 400) > 1);
});

test('the layout settles within 400 ticks', () => {
	const nodes = Array.from({length: 40}, (_, i) => node(`n${i}`, (i % 5) + 1));
	const edges = Array.from({length: 39}, (_, i) => ({from: `n${i}`, to: `n${i + 1}`}));
	const s = sim.createSim(nodes, edges);
	const ticks = settle(s);
	assert.ok(ticks < 400, String(ticks));
	assert.equal(sim.isActive(s), false);
	assert.equal(sim.tick(s), false);
});

test('reheat and setEdges restart movement', () => {
	const s = sim.createSim([node('a'), node('b')], []);
	settle(s);
	assert.equal(sim.isActive(s), false);
	sim.setEdges(s, [{from: 'a', to: 'b'}, {from: 'a', to: 'missing'}]);
	assert.equal(s.links.length, 1);
	sim.reheat(s, 0.3);
	assert.ok(sim.isActive(s));
	assert.equal(sim.tick(s), true);
});
