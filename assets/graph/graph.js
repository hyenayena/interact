import {createSim, isActive, pin, reheat, setEdges, tick, unpin} from '/interact/assets/sim.js';

const SAVE_DELAY_MS = 500;
const EDGE_HIT_PX = 6;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const LABEL_ZOOM = 0.6;
const ARROW = 9;
const FONT = '12px system-ui, sans-serif';

const $ = id => document.getElementById(id);
const canvas = $('canvas');
const g2d = canvas.getContext('2d');
const statusEl = $('status');
const graphId = location.pathname.split('/').filter(Boolean).pop();
const dataUrl = `${location.pathname.replace(/\/+$/, '')}/data`;
const apiUrl = action => `${location.pathname.replace(/\/+$/, '')}/${action}`;

const NO_CHAT = `Saved. No chat is open; ask the assistant to run "interact graph get ${graphId}".`;
const REFUSED = `Saved. The open chat does not take messages from modules (it needs an API key); ask the assistant to run "interact graph get ${graphId}".`;

const state = {
	data: null,
	sim: null,
	edges: [],
	cam: {x: 0, y: 0, k: 1},
	size: {w: 1, h: 1, dpr: 1},
	editable: false,
	connect: false,
	kind: 'plain',
	source: null,
	selection: null,
	hover: null,
	drag: null,
	pointer: {x: 0, y: 0},
	raf: 0,
	saveTimer: 0,
	saving: Promise.resolve(),
};

function setStatus(text) {
	statusEl.textContent = text;
}

function toWorld(sx, sy) {
	return {x: (sx - state.cam.x) / state.cam.k, y: (sy - state.cam.y) / state.cam.k};
}

function localPoint(event) {
	const rect = canvas.getBoundingClientRect();
	return {x: event.clientX - rect.left, y: event.clientY - rect.top};
}

function nodeAt(wx, wy) {
	const slack = 3 / state.cam.k;
	let found = null;
	for (const node of state.sim.nodes) {
		if (Math.hypot(node.x - wx, node.y - wy) <= node.r + slack) found = node;
	}
	return found;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
	const dx = bx - ax;
	const dy = by - ay;
	const lengthSq = dx * dx + dy * dy;
	const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function edgeAt(wx, wy) {
	const limit = EDGE_HIT_PX / state.cam.k;
	let best = -1;
	let bestDistance = limit;
	state.edges.forEach((edge, i) => {
		const a = state.sim.index.get(edge.from);
		const b = state.sim.index.get(edge.to);
		const d = distanceToSegment(wx, wy, a.x, a.y, b.x, b.y);
		if (d <= bestDistance) {
			best = i;
			bestDistance = d;
		}
	});
	return best;
}

function schedule() {
	if (!state.raf) state.raf = requestAnimationFrame(frame);
}

function frame() {
	state.raf = 0;
	const moving = tick(state.sim);
	draw();
	if (moving || isActive(state.sim) || state.drag) schedule();
}

function resize() {
	const rect = canvas.getBoundingClientRect();
	const dpr = window.devicePixelRatio || 1;
	state.size = {w: Math.max(1, rect.width), h: Math.max(1, rect.height), dpr};
	canvas.width = Math.round(state.size.w * dpr);
	canvas.height = Math.round(state.size.h * dpr);
	schedule();
}

function arrowHead(x, y, angle, color) {
	g2d.save();
	g2d.translate(x, y);
	g2d.rotate(angle);
	g2d.fillStyle = color;
	g2d.beginPath();
	g2d.moveTo(0, 0);
	g2d.lineTo(-ARROW, ARROW * 0.45);
	g2d.lineTo(-ARROW, -ARROW * 0.45);
	g2d.closePath();
	g2d.fill();
	g2d.restore();
}

function drawEdge(edge, selected) {
	const a = state.sim.index.get(edge.from);
	const b = state.sim.index.get(edge.to);
	const angle = Math.atan2(b.y - a.y, b.x - a.x);
	const color = selected ? '#f0883e' : '#6e7681';
	g2d.strokeStyle = color;
	g2d.lineWidth = (selected ? 3 : 1.5) / Math.sqrt(state.cam.k);
	g2d.beginPath();
	g2d.moveTo(a.x, a.y);
	g2d.lineTo(b.x, b.y);
	g2d.stroke();
	if (edge.kind === 'directed' || edge.kind === 'bidirectional') {
		arrowHead(b.x - Math.cos(angle) * (b.r + 2), b.y - Math.sin(angle) * (b.r + 2), angle, color);
	}
	if (edge.kind === 'bidirectional') {
		arrowHead(a.x + Math.cos(angle) * (a.r + 2), a.y + Math.sin(angle) * (a.r + 2), angle + Math.PI, color);
	}
}

function draw() {
	const {w, h, dpr} = state.size;
	g2d.setTransform(dpr, 0, 0, dpr, 0, 0);
	g2d.clearRect(0, 0, w, h);
	g2d.setTransform(dpr * state.cam.k, 0, 0, dpr * state.cam.k, dpr * state.cam.x, dpr * state.cam.y);
	const selectedEdge = state.selection && state.selection.kind === 'edge' ? state.selection.index : -1;
	state.edges.forEach((edge, i) => drawEdge(edge, i === selectedEdge));
	g2d.font = FONT;
	g2d.textAlign = 'center';
	g2d.textBaseline = 'top';
	const labelsOn = state.cam.k >= LABEL_ZOOM;
	for (const node of state.sim.nodes) {
		const meta = state.data.byId.get(node.id);
		g2d.fillStyle = meta.color;
		g2d.beginPath();
		g2d.arc(node.x, node.y, node.r, 0, Math.PI * 2);
		g2d.fill();
		if (node === state.source || node === state.hover) {
			g2d.strokeStyle = '#ffffff';
			g2d.lineWidth = 2 / state.cam.k;
			g2d.stroke();
		}
		if (state.selection && state.selection.kind === 'node' && state.selection.id === node.id) {
			g2d.strokeStyle = '#f0883e';
			g2d.lineWidth = 3 / state.cam.k;
			g2d.beginPath();
			g2d.arc(node.x, node.y, node.r + 3 / state.cam.k, 0, Math.PI * 2);
			g2d.stroke();
		}
		if (labelsOn || node === state.hover) {
			g2d.fillStyle = '#e6edf3';
			g2d.fillText(meta.label, node.x, node.y + node.r + 3);
		}
	}
	if (state.drag && state.drag.kind === 'edge') {
		const from = state.sim.index.get(state.drag.id);
		const to = toWorld(state.pointer.x, state.pointer.y);
		g2d.strokeStyle = '#f0883e';
		g2d.lineWidth = 2 / state.cam.k;
		g2d.beginPath();
		g2d.moveTo(from.x, from.y);
		g2d.lineTo(to.x, to.y);
		g2d.stroke();
	}
}

function fit() {
	const nodes = state.sim.nodes;
	if (nodes.length === 0) return;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const n of nodes) {
		minX = Math.min(minX, n.x - n.r);
		maxX = Math.max(maxX, n.x + n.r);
		minY = Math.min(minY, n.y - n.r);
		maxY = Math.max(maxY, n.y + n.r + 18);
	}
	const k = Math.max(MIN_ZOOM, Math.min(2, (state.size.w - 80) / Math.max(1, maxX - minX), (state.size.h - 80) / Math.max(1, maxY - minY)));
	state.cam.k = k;
	state.cam.x = state.size.w / 2 - ((minX + maxX) / 2) * k;
	state.cam.y = state.size.h / 2 - ((minY + maxY) / 2) * k;
	schedule();
}

function pairIndex(a, b) {
	return state.edges.findIndex(e => (e.from === a && e.to === b) || (e.from === b && e.to === a));
}

function setSelection(selection) {
	state.selection = selection;
	$('remove').disabled = !(selection && selection.kind === 'edge');
	showNodePanel();
	schedule();
}

function clearEdgeSelection() {
	if (state.selection && state.selection.kind === 'edge') setSelection(null);
}

function showNodePanel() {
	const sel = state.selection;
	const panel = $('node-panel');
	panel.hidden = !(state.editable && sel && sel.kind === 'node');
	if (panel.hidden) return;
	const meta = state.data.byId.get(sel.id);
	$('node-label').textContent = meta.label;
	let named = false;
	for (const button of $('swatches').children) {
		const on = state.data.palette[button.dataset.color] === meta.color;
		named = named || on;
		button.setAttribute('aria-pressed', String(on));
	}
	$('node-color').textContent = named ? '' : `custom ${meta.color}`;
}

function buildSwatches() {
	for (const [name, hex] of Object.entries(state.data.palette)) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'swatch';
		button.dataset.color = name;
		button.setAttribute('aria-label', name);
		button.setAttribute('aria-pressed', 'false');
		button.title = name;
		button.style.backgroundColor = hex;
		button.addEventListener('click', () => setNodeColor(name));
		$('swatches').appendChild(button);
	}
}

function selectedMeta() {
	const sel = state.selection;
	return state.editable && sel && sel.kind === 'node' ? state.data.byId.get(sel.id) : null;
}

function setNodeColor(name) {
	const meta = selectedMeta();
	if (!meta) return;
	meta.color = state.data.palette[name];
	showNodePanel();
	scheduleSave();
	schedule();
}

function addEdge(from, to) {
	if (!state.editable || from === to) return;
	const existing = pairIndex(from, to);
	if (existing >= 0) state.edges.splice(existing, 1);
	state.edges.push({from, to, kind: state.kind});
	clearEdgeSelection();
	edgesChanged();
}

function removeSelected() {
	const sel = state.selection;
	if (!state.editable || !sel || sel.kind !== 'edge') return;
	state.edges.splice(sel.index, 1);
	setSelection(null);
	edgesChanged();
}

function edgesChanged() {
	setEdges(state.sim, state.edges);
	reheat(state.sim, 0.3);
	scheduleSave();
	schedule();
}

async function postJson(action, body) {
	const response = await fetch(apiUrl(action), {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify(body),
	});
	let payload = {};
	try {
		payload = await response.json();
	} catch {
		payload = {};
	}
	if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
	return payload;
}

function scheduleSave() {
	clearTimeout(state.saveTimer);
	setStatus('Unsaved changes');
	state.saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

function body() {
	return {edges: state.edges, nodes: state.data.nodes.map(n => ({id: n.id, color: n.color}))};
}

function save() {
	state.saveTimer = 0;
	setStatus('Saving...');
	state.saving = postJson('edges', body())
		.then(() => setStatus('Saved'))
		.catch(err => setStatus(`Not saved: ${err.message}`));
	return state.saving;
}

function setEditable(on) {
	state.editable = on;
	$('toolbar').hidden = !on;
	if (!on) {
		state.connect = false;
		state.source = null;
		setSelection(null);
	}
	schedule();
}

async function finish() {
	if (!state.editable) return;
	clearTimeout(state.saveTimer);
	state.saveTimer = 0;
	await state.saving;
	setStatus('Sending...');
	try {
		const result = await postJson('done', body());
		setEditable(false);
		showHelp();
		setStatus(result.chat === 'sent' ? 'Sent to the chat.' : result.chat === 'refused' ? REFUSED : NO_CHAT);
	} catch (err) {
		setStatus(`Not sent: ${err.message}`);
	}
}

function setConnect(on) {
	state.connect = on && state.editable;
	state.source = null;
	$('connect').setAttribute('aria-pressed', String(state.connect));
	schedule();
}

function setKind(kind) {
	state.kind = kind;
	for (const button of document.querySelectorAll('[data-kind]')) {
		button.setAttribute('aria-pressed', String(button.dataset.kind === kind));
	}
}

function onPointerDown(event) {
	canvas.focus();
	const p = localPoint(event);
	state.pointer = p;
	const w = toWorld(p.x, p.y);
	const node = nodeAt(w.x, w.y);
	canvas.setPointerCapture(event.pointerId);
	if (node && state.editable && state.connect) {
		if (!state.source) state.source = node;
		else {
			addEdge(state.source.id, node.id);
			state.source = null;
		}
		schedule();
		return;
	}
	if (node && state.editable && event.shiftKey) {
		state.drag = {kind: 'edge', id: node.id};
	} else if (node) {
		state.drag = {kind: 'node', id: node.id, dx: node.x - w.x, dy: node.y - w.y};
		pin(state.sim, node.id, node.x, node.y);
		if (state.editable) setSelection({kind: 'node', id: node.id});
	} else {
		const hit = state.editable ? edgeAt(w.x, w.y) : -1;
		setSelection(hit >= 0 ? {kind: 'edge', index: hit} : null);
		state.drag = {kind: 'pan', x: p.x, y: p.y, cx: state.cam.x, cy: state.cam.y};
		if (state.connect) state.source = null;
	}
	schedule();
}

function onPointerMove(event) {
	const p = localPoint(event);
	state.pointer = p;
	const w = toWorld(p.x, p.y);
	const drag = state.drag;
	if (drag && drag.kind === 'node') pin(state.sim, drag.id, w.x + drag.dx, w.y + drag.dy);
	else if (drag && drag.kind === 'pan') {
		state.cam.x = drag.cx + (p.x - drag.x);
		state.cam.y = drag.cy + (p.y - drag.y);
	}
	const hover = nodeAt(w.x, w.y);
	if (hover !== state.hover || drag) {
		state.hover = hover;
		schedule();
	}
}

function onPointerUp(event) {
	const drag = state.drag;
	state.drag = null;
	if (!drag) return;
	const p = localPoint(event);
	const w = toWorld(p.x, p.y);
	if (drag.kind === 'node') unpin(state.sim, drag.id);
	else if (drag.kind === 'edge') {
		const target = nodeAt(w.x, w.y);
		if (target) addEdge(drag.id, target.id);
	}
	schedule();
}

function onWheel(event) {
	event.preventDefault();
	const p = localPoint(event);
	const before = toWorld(p.x, p.y);
	const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.cam.k * Math.exp(-event.deltaY * 0.0015)));
	state.cam.k = k;
	state.cam.x = p.x - before.x * k;
	state.cam.y = p.y - before.y * k;
	schedule();
}

function onKey(event) {
	if (event.ctrlKey || event.metaKey || event.altKey) return;
	const key = event.key.toLowerCase();
	if (key === 'f') fit();
	else if (!state.editable) return;
	else if (key === 'c') setConnect(!state.connect);
	else if (key === 'escape') {
		state.source = null;
		setSelection(null);
		setConnect(false);
	} else if (key === 'delete' || key === 'backspace') {
		event.preventDefault();
		removeSelected();
	} else if (key === '1') setKind('plain');
	else if (key === '2') setKind('directed');
	else if (key === '3') setKind('bidirectional');
}

function showHelp() {
	$('help').textContent = state.editable
		? 'Drag nodes to move them, drag empty space to pan, scroll to zoom. Connect (C) then click two nodes, or Shift+drag from one node to another. Click an edge and press Delete to remove it. Click a node to change its color. Keys 1, 2, 3 pick the edge kind; F fits the view.'
		: 'Drag nodes to move them, drag empty space to pan, scroll to zoom. F fits the view.';
}

async function main() {
	let data;
	try {
		const response = await fetch(dataUrl);
		if (!response.ok) throw new Error(`The graph could not be loaded (${response.status})`);
		data = await response.json();
	} catch (err) {
		setStatus(err.message);
		return;
	}
	data.byId = new Map(data.nodes.map(n => [n.id, n]));
	state.data = data;
	state.edges = data.edges.map(e => ({...e}));
	state.sim = createSim(data.nodes, state.edges);
	buildSwatches();
	$('title').textContent = data.title || 'Graph';
	document.title = data.title || 'Graph';
	setEditable(data.interactive && !data.finished);
	setStatus(data.finished ? 'Finished' : data.interactive ? '' : 'View only');
	showHelp();
	resize();
	for (let i = 0; i < 120; i++) tick(state.sim);
	fit();
	canvas.addEventListener('pointerdown', onPointerDown);
	canvas.addEventListener('pointermove', onPointerMove);
	canvas.addEventListener('pointerup', onPointerUp);
	canvas.addEventListener('pointercancel', onPointerUp);
	canvas.addEventListener('wheel', onWheel, {passive: false});
	window.addEventListener('resize', resize);
	window.addEventListener('keydown', onKey);
	$('connect').addEventListener('click', () => setConnect(!state.connect));
	$('remove').addEventListener('click', removeSelected);
	$('fit').addEventListener('click', fit);
	$('done').addEventListener('click', finish);
	for (const button of document.querySelectorAll('[data-kind]')) button.addEventListener('click', () => setKind(button.dataset.kind));
	schedule();
}

main();
