import {formatEdge, formatRestyle, type GraphDiff} from './schema.js';
import type {GraphRecord} from './store.js';

export const MESSAGE_MAX = 4000;
const ENTRY_STEPS = [40, 20, 10, 5, 2, 1, 0];
const TITLE_MAX = 80;
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]', 'g');

const clipTitle = (title: string): string => {
	const clean = title.replace(UNSAFE, ' ').replace(/"/g, "'").trim();
	const chars = Array.from(clean);
	return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : clean;
};

function listLine(label: string, entries: readonly string[], shown: number, noun = 'edge'): string {
	if (entries.length === 0) return `${label}: (none)`;
	if (shown === 0) return `${label}: ${entries.length} ${noun}${entries.length === 1 ? '' : 's'}`;
	const head = entries.slice(0, shown).join('; ');
	return entries.length > shown ? `${label}: ${head}; and ${entries.length - shown} more` : `${label}: ${head}`;
}

export function resultMessage(graph: Pick<GraphRecord, 'id' | 'title'>, diff: GraphDiff): string {
	const added = diff.added.map(formatEdge);
	const removed = diff.removed.map(formatEdge);
	const changed = diff.changed.map(c => `${formatEdge(c.before)} => ${formatEdge(c.after)}`);
	const title = graph.title ? ` "${clipTitle(graph.title)}"` : '';
	let text = '';
	for (const shown of ENTRY_STEPS) {
		text = [
			`[interact] The user pressed Done on graph ${graph.id}${title}.`,
			listLine('Added', added, shown),
			listLine('Removed', removed, shown),
			listLine('Changed', changed, shown),
			listLine('Restyled', diff.restyled.map(formatRestyle), shown, 'node'),
			`The full graph: interact graph get ${graph.id}`,
		].join('\n');
		if (text.length <= MESSAGE_MAX) break;
	}
	return text;
}
