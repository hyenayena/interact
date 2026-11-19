import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import plugin from '../src/index.js';
import {registerRoute} from '../src/deps/web.js';

const dir = mkdtempSync(path.join(tmpdir(), 'interact-index-'));
after(() => rmSync(dir, {recursive: true, force: true}));

const host = () => ({dataDir: dir, events: {emit() {}, on: () => () => {}}, log: undefined as never});

test('registers the interact command and its web routes', async () => {
	const commands = await plugin(host() as never);
	assert.deepEqual(commands.map(c => c.name), ['interact']);
	for (const endpoint of ['graph', 'assets']) {
		assert.throws(() => registerRoute({module: 'interact', endpoint, methods: ['GET'], handle: () => ({status: 200})}), /already registered/);
	}
});

test('a second plugin call does not throw and keeps one set of routes', async () => {
	await plugin(host() as never);
	await assert.doesNotReject(async () => plugin(host() as never));
	assert.throws(() => registerRoute({module: 'interact', endpoint: 'graph', methods: ['GET'], handle: () => ({status: 200})}), /already registered/);
});

test('works without a host logger', async () => {
	await assert.doesNotReject(async () => plugin(host() as never));
});
