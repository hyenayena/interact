import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {test} from 'node:test';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/graph/sim.js');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sim: any = await import(pathToFileURL(file).href);

const node = (id: string) => ({id});
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

test('radius grows with the degree and is capped', () => {
	assert.deepEqual([0, 1, 4, 100].map(sim.radiusOf), [5, 10, 15, 40]);
	assert.equal(sim.radiusOf(1000), sim.MAX_RADIUS);
	for (let d = 1; d <= 60; d++) assert.ok(sim.radiusOf(d) >= sim.radiusOf(d - 1), String(d));
});

test('setEdges sets each radius from the degree', () => {
	const s = sim.createSim(['a', 'b', 'c', 'd', 'e'].map(node), []);
	assert.ok(s.nodes.every((n: any) => n.r === 5));
	sim.setEdges(s, [{from: 'a', to: 'b'}, {from: 'a', to: 'c'}, {from: 'd', to: 'a'}, {from: 'a', to: 'missing'}]);
	assert.equal(s.index.get('a').r, sim.radiusOf(3));
	for (const id of ['b', 'c', 'd']) assert.equal(s.index.get(id).r, sim.radiusOf(1));
	assert.equal(s.index.get('e').r, 5);
	sim.setEdges(s, [{from: 'a', to: 'b'}]);
	assert.equal(s.index.get('a').r, sim.radiusOf(1));
	assert.equal(s.index.get('c').r, 5);
});

test('self-loops and edges to missing nodes do not count towards the degree, duplicates do', () => {
	const s = sim.createSim(['a', 'b', 'c'].map(node), []);
	sim.setEdges(s, [{from: 'a', to: 'a'}, {from: 'a', to: 'ghost'}, {from: 'ghost', to: 'b'}]);
	assert.ok(s.nodes.every((n: any) => n.r === 5));
	assert.equal(s.links.length, 0);
	sim.setEdges(s, [{from: 'a', to: 'b'}, {from: 'a', to: 'b'}, {from: 'b', to: 'a'}, {from: 'c', to: 'c'}]);
	assert.equal(s.index.get('a').r, sim.radiusOf(3));
	assert.equal(s.index.get('b').r, sim.radiusOf(3));
	assert.equal(s.index.get('c').r, 5);
});

test('the radius never exceeds the cap however many edges', () => {
	const s = sim.createSim(['a', 'b'].map(node), []);
	sim.setEdges(s, Array.from({length: 500}, () => ({from: 'a', to: 'b'})));
	assert.ok(s.nodes.every((n: any) => n.r === sim.MAX_RADIUS));
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
	const nodes = Array.from({length: 40}, (_, i) => node(`n${i}`));
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

test('a settled tree spreads out: no two nodes overlap', () => {
	const nodes = Array.from({length: 120}, (_, i) => node(`n${i}`));
	const edges = nodes.slice(1).map((n, i) => ({from: n.id, to: `n${Math.floor(i / 3)}`}));
	const s = sim.createSim(nodes, edges);
	settle(s, 1000);
	let gap = Infinity;
	for (let i = 0; i < s.nodes.length; i++)
		for (let j = i + 1; j < s.nodes.length; j++) {
			const a = s.nodes[i];
			const b = s.nodes[j];
			gap = Math.min(gap, Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r);
		}
	assert.ok(gap > 2, `nodes overlap: gap ${gap.toFixed(1)}`);
});

test('a hub with many edges does not overlap its neighbours', () => {
	const nodes = Array.from({length: 61}, (_, i) => node(`n${i}`));
	const s = sim.createSim(nodes, []);
	settle(s, 1000);
	sim.setEdges(s, nodes.slice(1).map(n => ({from: 'n0', to: n.id})));
	sim.reheat(s, 0.3);
	settle(s, 1000);
	assert.equal(s.index.get('n0').r, sim.MAX_RADIUS);
	let gap = Infinity;
	for (let i = 0; i < s.nodes.length; i++)
		for (let j = i + 1; j < s.nodes.length; j++) {
			const a = s.nodes[i];
			const b = s.nodes[j];
			gap = Math.min(gap, Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r);
		}
	assert.ok(gap > 2, `nodes overlap: gap ${gap.toFixed(1)}`);
});
