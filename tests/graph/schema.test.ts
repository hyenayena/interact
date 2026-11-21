import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkChange, checkEdges, checkNodeStyles, colorName, COLORS, diffEdges, diffGraph, diffStyles, formatEdge, formatRestyle, GRAPH_LIMITS, parseGraphText, validateGraph} from '../../src/graph/schema.js';

const ok = (value: unknown) => validateGraph(value);
const bad = (value: unknown, pattern: RegExp) => assert.throws(() => validateGraph(value), pattern);
const nodes = (n: number) => Array.from({length: n}, (_, i) => ({id: `n${i}`}));

test('defaults are filled in', () => {
	const g = ok({nodes: [{id: 'a'}, {id: 'b', label: '  Bee  ', color: 'red'}, {id: 'c', color: '#ABC'}], edges: [{from: 'a', to: 'b'}]});
	assert.deepEqual(g.nodes[0], {id: 'a', label: 'a', color: COLORS.blue});
	assert.deepEqual(g.nodes[1], {id: 'b', label: 'Bee', color: COLORS.red});
	assert.equal(g.nodes[2]!.color, '#abc');
	assert.deepEqual(g.edges, [{from: 'a', to: 'b', kind: 'plain'}]);
	assert.equal(g.title, undefined);
	assert.equal(ok({title: '  T  ', nodes: nodes(1)}).title, 'T');
});

test('limits are enforced', () => {
	assert.equal(ok({nodes: nodes(GRAPH_LIMITS.nodes)}).nodes.length, 500);
	bad({nodes: nodes(GRAPH_LIMITS.nodes + 1)}, /nodes: more than 500 nodes/);
	bad({nodes: []}, /at least one node/);
	bad({nodes: [{id: 'a', label: 'x'.repeat(121)}]}, /nodes\[0\]\.label: longer than 120 characters/);
	assert.equal(ok({nodes: [{id: 'a', label: 'x'.repeat(120)}]}).nodes[0]!.label.length, 120);
	bad({title: 'x'.repeat(121), nodes: nodes(1)}, /title: longer than 120/);
	const many = Array.from({length: 2001}, (_, i) => ({from: `n${i % 100}`, to: `n${(i % 100) + 100}`}));
	bad({nodes: nodes(300), edges: many}, /edges: more than 2000/);
});

test('node fields are checked', () => {
	bad({nodes: [{id: ''}]}, /nodes\[0\]\.id/);
	bad({nodes: [{id: 'a b'}]}, /nodes\[0\]\.id/);
	bad({nodes: [{id: 'x'.repeat(65)}]}, /nodes\[0\]\.id/);
	bad({nodes: [{id: 5}]}, /nodes\[0\]\.id/);
	bad({nodes: [{id: 'a'}, {id: 'a'}]}, /nodes\[1\]\.id: duplicate id "a"/);
	bad({nodes: [{id: 'a', size: 2}]}, /nodes\[0\]: unknown key$/);
	for (const color of ['mauve', '#12', '#12345g', 5, 'constructor', '__proto__']) bad({nodes: [{id: 'a', color}]}, /color/);
	bad({nodes: [{id: 'a', label: 5}]}, /label: must be a string/);
	bad({nodes: ['a']}, /nodes\[0\]: must be an object/);
});

test('control and bidi characters are refused', () => {
	for (const ch of ['\u0000', '\n', '\u001b', '\u0085', '‮', '⁦', '⁩']) {
		bad({nodes: [{id: 'a', label: `x${ch}y`}]}, /control characters/);
		bad({title: `x${ch}y`, nodes: nodes(1)}, /control characters/);
	}
});

test('unknown keys are refused', () => {
	bad({nodes: nodes(1), extra: 1}, /graph: unknown key$/);
	bad({nodes: [{id: 'a', shape: 'x'}]}, /nodes\[0\]: unknown key$/);
	bad({nodes: nodes(2), edges: [{from: 'n0', to: 'n1', weight: 3}]}, /edges\[0\]: unknown key$/);
	bad({nodes: nodes(1), 'a\nb': 1}, /graph: unknown key$/);
	bad([], /must be a JSON object/);
	bad(null, /must be a JSON object/);
});

test('edges are checked', () => {
	bad({nodes: nodes(2), edges: [{from: 'n0', to: 'zz'}]}, /edges\[0\]\.to: no such node "zz"/);
	bad({nodes: nodes(2), edges: [{from: 'n0', to: 'n0'}]}, /itself/);
	bad({nodes: nodes(2), edges: [{from: 'n0', to: 'n1', kind: 'weird'}]}, /kind/);
	bad({nodes: nodes(2), edges: [{from: 'n0', to: 'n1'}, {from: 'n0', to: 'n1'}]}, /already have an edge/);
	bad({nodes: nodes(2), edges: [{from: 'n0', to: 'n1', kind: 'directed'}, {from: 'n1', to: 'n0', kind: 'directed'}]}, /use kind bidirectional/);
	bad({nodes: nodes(2), edges: {from: 'n0'}}, /edges: must be a list/);
	bad({nodes: nodes(2), edges: [{from: 'n0', to: 'bad id!'}]}, /no such node$/);
});

test('parseGraphText checks the size and never echoes the parser message', () => {
	assert.throws(() => parseGraphText('x'.repeat(GRAPH_LIMITS.inputBytes + 1)), /larger than 262144 bytes/);
	assert.throws(() => parseGraphText('{"secret": oops'), (e: Error) => e.message === 'The graph is not valid JSON');
	assert.equal(parseGraphText('{"nodes":[{"id":"a"}]}').nodes.length, 1);
});

test('checkEdges validates a page post against the nodes', () => {
	const list = [{id: 'a'}, {id: 'b'}];
	assert.deepEqual(checkEdges(list, [{from: 'a', to: 'b', kind: 'directed'}]), [{from: 'a', to: 'b', kind: 'directed'}]);
	assert.throws(() => checkEdges(list, [{from: 'a', to: 'c'}]), /no such node/);
	assert.throws(() => checkEdges(list, 'x'), /must be a list/);
});

test('checkNodeStyles validates node styles against the nodes', () => {
	const list = [{id: 'a'}, {id: 'b'}];
	assert.deepEqual(checkNodeStyles(list, [{id: 'a', color: 'red'}, {id: 'b', color: '#ABC'}]), [
		{id: 'a', color: COLORS.red},
		{id: 'b', color: '#abc'},
	]);
	assert.deepEqual(checkNodeStyles(list, []), []);
	const refuse = (value: unknown, pattern: RegExp) => assert.throws(() => checkNodeStyles(list, value), pattern);
	refuse('x', /nodes: must be a list/);
	refuse([{id: 'z', color: 'red'}], /nodes\[0\]\.id: no such node "z"$/);
	refuse([{id: 'a b', color: 'red'}], /nodes\[0\]\.id: no such node$/);
	refuse([{id: 'a', color: 'red'}, {id: 'a', color: 'red'}], /nodes\[1\]\.id: duplicate id "a"/);
	refuse([{id: 'a', size: 2, color: 'red'}], /nodes\[0\]: unknown key$/);
	for (const color of ['nope', '#12', 5, undefined]) refuse([{id: 'a', color}], /nodes\[0\]\.color: /);
	refuse([{id: 'a', color: 'red', label: 'x'}], /nodes\[0\]: unknown key$/);
	refuse([1], /nodes\[0\]: must be an object/);
	refuse(Array.from({length: GRAPH_LIMITS.nodes + 1}, () => ({})), /more than 500 nodes/);
});

test('checkChange takes {edges, nodes?} and nothing else', () => {
	const list = [{id: 'a'}, {id: 'b'}];
	for (const body of [{}, {nodes: []}, {edges: [], extra: 1}, [], null, 'x']) assert.throws(() => checkChange(list, body), /^Error: The body must be \{"edges": \[\.\.\.\], "nodes"\?: \[\.\.\.\]\}$/);
	assert.throws(() => checkChange(list, {edges: [], nodes: 'x'}), /nodes: must be a list/);
	assert.deepEqual(checkChange(list, {edges: []}), {edges: []});
	assert.deepEqual(checkChange(list, {edges: [], nodes: [{id: 'a', color: 'teal'}]}), {edges: [], styles: [{id: 'a', color: COLORS.teal}]});
});

test('diffGraph and diffStyles list only the restyled nodes', () => {
	const initial = [{id: 'a', color: COLORS.blue}, {id: 'b', color: COLORS.blue}, {id: 'c', color: '#abcdef'}];
	const current = [{id: 'c', color: '#123456'}, {id: 'b', color: COLORS.blue}, {id: 'a', color: COLORS.red}];
	assert.deepEqual(diffStyles(initial, current).map(r => r.id), ['c', 'a']);
	const diff = diffGraph({initialEdges: [], edges: [{from: 'a', to: 'b', kind: 'plain'}], initialStyles: initial, nodes: current});
	assert.equal(diff.added.length, 1);
	assert.deepEqual(diff.restyled.map(formatRestyle), ['c: color #abcdef -> #123456', 'a: color blue -> red']);
	assert.deepEqual(diffStyles(initial, initial), []);
});

test('colorName gives the name of a palette color or the hex', () => {
	assert.equal(colorName(COLORS.blue!), 'blue');
	assert.equal(colorName('#abcdef'), '#abcdef');
	assert.equal(formatRestyle({id: 'x', before: {color: COLORS.gray!}, after: {color: '#fff'}}), 'x: color gray -> #fff');
});

test('diffEdges finds added, removed and changed edges', () => {
	const initial = [
		{from: 'a', to: 'b', kind: 'plain'},
		{from: 'b', to: 'c', kind: 'directed'},
		{from: 'c', to: 'd', kind: 'plain'},
		{from: 'd', to: 'e', kind: 'bidirectional'},
	] as const;
	const current = [
		{from: 'c', to: 'b', kind: 'directed'},
		{from: 'a', to: 'b', kind: 'plain'},
		{from: 'e', to: 'd', kind: 'bidirectional'},
		{from: 'a', to: 'e', kind: 'plain'},
		{from: 'c', to: 'd', kind: 'directed'},
	] as const;
	const diff = diffEdges(initial, current);
	assert.deepEqual(diff.added, [{from: 'a', to: 'e', kind: 'plain'}]);
	assert.deepEqual(diff.removed, []);
	assert.deepEqual(diff.changed.map(c => [formatEdge(c.before), formatEdge(c.after)]), [
		['b -> c', 'c -> b'],
		['c -- d', 'c -> d'],
	]);
	assert.deepEqual(diffEdges(current, []).removed.length, 5);
});

test('formatEdge shows the direction', () => {
	assert.equal(formatEdge({from: 'a', to: 'b', kind: 'plain'}), 'a -- b');
	assert.equal(formatEdge({from: 'a', to: 'b', kind: 'directed'}), 'a -> b');
	assert.equal(formatEdge({from: 'a', to: 'b', kind: 'bidirectional'}), 'a <-> b');
});
