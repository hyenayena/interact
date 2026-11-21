export const MIN_ALPHA = 0.001;

const ALPHA_DECAY = 0.0228;
const DRAG_TARGET = 0.3;
const VELOCITY_KEEP = 0.6;
// Repulsion falls off as 1/d, as in d3's many-body force; 1/d² is too weak and the graph collapses.
const REPULSION = 80;
const CUTOFF = 1000;
const MIN_DISTANCE = 5;
const COLLIDE_GAP = 8;
const SPRING_LENGTH = 90;
const SPRING_STRENGTH = 0.08;
const CENTERING = 0.005;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const RADIUS_BASE = 5;
const RADIUS_STEP = 5;
export const MAX_RADIUS = 40;

export function radiusOf(degree) {
	return Math.min(MAX_RADIUS, RADIUS_BASE + RADIUS_STEP * Math.sqrt(Math.max(0, degree)));
}

export function createSim(nodes, edges) {
	const sim = {nodes: [], index: new Map(), links: [], alpha: 1, target: 0};
	nodes.forEach((node, i) => {
		const radius = 18 * Math.sqrt(i + 0.5);
		const angle = i * GOLDEN_ANGLE;
		const item = {id: node.id, x: radius * Math.cos(angle), y: radius * Math.sin(angle), vx: 0, vy: 0, r: radiusOf(0), pinned: false};
		sim.nodes.push(item);
		sim.index.set(node.id, item);
	});
	setEdges(sim, edges);
	return sim;
}

export function setEdges(sim, edges) {
	sim.links = [];
	for (const edge of edges) {
		const source = sim.index.get(edge.from);
		const target = sim.index.get(edge.to);
		if (source && target && source !== target) sim.links.push({source, target});
	}
	const degree = new Map();
	for (const {source, target} of sim.links) {
		degree.set(source, (degree.get(source) ?? 0) + 1);
		degree.set(target, (degree.get(target) ?? 0) + 1);
	}
	for (const node of sim.nodes) node.r = radiusOf(degree.get(node) ?? 0);
}

export function reheat(sim, alpha) {
	sim.alpha = Math.max(sim.alpha, alpha);
}

export function pin(sim, id, x, y) {
	const node = sim.index.get(id);
	if (!node) return;
	node.pinned = true;
	node.x = x;
	node.y = y;
	node.vx = 0;
	node.vy = 0;
	sim.target = DRAG_TARGET;
	reheat(sim, DRAG_TARGET);
}

export function unpin(sim, id) {
	const node = sim.index.get(id);
	if (node) node.pinned = false;
	sim.target = 0;
}

export function isActive(sim) {
	return sim.alpha > MIN_ALPHA || sim.target > 0;
}

export function tick(sim) {
	sim.alpha += (sim.target - sim.alpha) * ALPHA_DECAY;
	if (sim.alpha < MIN_ALPHA && sim.target === 0) return false;
	const {nodes, alpha} = sim;
	const cutoffSq = CUTOFF * CUTOFF;
	for (let i = 0; i < nodes.length; i++) {
		const a = nodes[i];
		for (let j = i + 1; j < nodes.length; j++) {
			const b = nodes[j];
			let dx = b.x - a.x;
			let dy = b.y - a.y;
			if (dx === 0 && dy === 0) {
				dx = 0.1 * (((i + 1) * 7 + j) % 5 - 2 || 1);
				dy = 0.1 * (((j + 1) * 3 + i) % 5 - 2 || 1);
			}
			const distSq = dx * dx + dy * dy;
			if (distSq > cutoffSq) continue;
			const dist = Math.sqrt(distSq);
			let push = (REPULSION * alpha) / Math.max(dist, MIN_DISTANCE);
			const overlap = a.r + b.r + COLLIDE_GAP - dist;
			if (overlap > 0) push += overlap * 0.5;
			const fx = (dx / dist) * push;
			const fy = (dy / dist) * push;
			a.vx -= fx;
			a.vy -= fy;
			b.vx += fx;
			b.vy += fy;
		}
	}
	for (const {source, target} of sim.links) {
		const dx = target.x - source.x;
		const dy = target.y - source.y;
		const dist = Math.max(Math.hypot(dx, dy), 1);
		const rest = SPRING_LENGTH + source.r + target.r;
		const pull = ((dist - rest) / dist) * SPRING_STRENGTH * alpha;
		source.vx += dx * pull;
		source.vy += dy * pull;
		target.vx -= dx * pull;
		target.vy -= dy * pull;
	}
	for (const node of nodes) {
		if (node.pinned) {
			node.vx = 0;
			node.vy = 0;
			continue;
		}
		node.vx -= node.x * CENTERING * alpha;
		node.vy -= node.y * CENTERING * alpha;
		node.vx *= VELOCITY_KEEP;
		node.vy *= VELOCITY_KEEP;
		node.x += node.vx;
		node.y += node.vy;
	}
	return true;
}
