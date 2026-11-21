import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/graph');
const read = (name: string): string => readFileSync(path.join(dir, name), 'utf8');

test('the scripts avoid the sinks the page policy forbids', () => {
	for (const name of ['graph.js', 'sim.js']) {
		const text = read(name);
		for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'document.write', 'setTimeout("', "setTimeout('"]) {
			assert.equal(text.includes(banned), false, `${name}: ${banned}`);
		}
	}
});

test('the page has no inline script or style and only same-origin assets', () => {
	const html = read('index.html');
	const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
	assert.equal(scripts.length, 1);
	assert.match(scripts[0]![1]!, /type="module"/);
	assert.match(scripts[0]![1]!, /src="\/interact\/assets\/graph\.js"/);
	assert.equal(scripts[0]![2]!.trim(), '');
	assert.match(html, /<link rel="stylesheet" href="\/interact\/assets\/graph\.css">/);
	assert.match(html, /id="node-panel"/);
	assert.doesNotMatch(html, /data-size/);
	assert.doesNotMatch(read('graph.js'), /setRadius|setNodeSize/);
	assert.equal(/<style\b|\sstyle=|\son[a-z]+=|https?:\/\//i.test(html), false);
});

test('graph.js imports the simulation from the assets route', () => {
	assert.match(read('graph.js'), /from '\/interact\/assets\/sim\.js'/);
});

test('the page is English text only', () => {
	assert.equal(new RegExp('[^\\u0000-\\u007f]').test(read('index.html') + read('graph.js')), false);
});
