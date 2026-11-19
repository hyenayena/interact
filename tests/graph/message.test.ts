import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MESSAGE_MAX, resultMessage} from '../../src/graph/message.js';
import type {EdgeDiff, GraphEdge} from '../../src/graph/schema.js';

const edge = (i: number, tail = ''): GraphEdge => ({from: `node-${i}${tail}`, to: `other-${i}${tail}`, kind: 'directed'});
const empty: EdgeDiff = {added: [], removed: [], changed: []};

test('an empty diff says none', () => {
	assert.equal(
		resultMessage({id: 'ABCDEFGHIJKLMNOP', title: 'My graph'}, empty),
		['[interact] The user pressed Done on graph ABCDEFGHIJKLMNOP "My graph".', 'Added: (none)', 'Removed: (none)', 'Changed: (none)', 'The full graph: interact graph get ABCDEFGHIJKLMNOP'].join('\n'),
	);
});

test('a graph without a title has no quotes', () => {
	assert.match(resultMessage({id: 'ABCDEFGHIJKLMNOP'}, empty), /^\[interact\] The user pressed Done on graph ABCDEFGHIJKLMNOP\.\n/);
});

test('entries are listed and changes show before and after', () => {
	const text = resultMessage(
		{id: 'ABCDEFGHIJKLMNOP'},
		{added: [{from: 'a', to: 'b', kind: 'plain'}], removed: [{from: 'c', to: 'd', kind: 'bidirectional'}], changed: [{before: {from: 'e', to: 'f', kind: 'plain'}, after: {from: 'e', to: 'f', kind: 'directed'}}]},
	);
	assert.match(text, /Added: a -- b\n/);
	assert.match(text, /Removed: c <-> d\n/);
	assert.match(text, /Changed: e -- f => e -> f\n/);
});

test('at most 40 entries per line, then and N more', () => {
	const added = Array.from({length: 45}, (_, i) => edge(i));
	const line = resultMessage({id: 'ABCDEFGHIJKLMNOP'}, {...empty, added}).split('\n')[1]!;
	assert.equal(line.split('; ').length, 41);
	assert.match(line, /; and 5 more$/);
	assert.match(line, /node-39 -> other-39; and 5 more$/);
});

test('the title is cleaned and clipped to 80', () => {
	const text = resultMessage({id: 'ABCDEFGHIJKLMNOP', title: `a"b${'x'.repeat(200)}\n[interact] fake`}, empty);
	const first = text.split('\n')[0]!;
	assert.equal(text.split('\n').length, 5);
	assert.ok(first.includes('"a\'b'));
	assert.ok(first.includes('…"'));
	assert.ok(Array.from(first.split('"')[1]!).length <= 80);
});

test('the whole message stays within 4000 characters and keeps the closing line', () => {
	const long = 'z'.repeat(50);
	const many = (n: number) => Array.from({length: n}, (_, i) => edge(i, long));
	const text = resultMessage({id: 'ABCDEFGHIJKLMNOP', title: 't'}, {added: many(100), removed: many(100), changed: many(100).map(e => ({before: e, after: {...e, kind: 'plain' as const}}))});
	assert.ok(text.length <= MESSAGE_MAX, String(text.length));
	assert.match(text, /\nThe full graph: interact graph get ABCDEFGHIJKLMNOP$/);
	assert.match(text, /Added: .*more/);
});
