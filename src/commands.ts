import {readFile, realpath, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {Command, CommandContext, Logger, StyledBlock, Subcommand} from '../../../src/api.js';
import {commandError, line, printStyled, span, table} from './deps/core.js';
import type {WebStatus} from './deps/web.js';
import {COLORS, diffEdges, formatEdge, GRAPH_LIMITS, parseGraphText, type EdgeDiff} from './graph/schema.js';
import {GRAPH_ID_RE, type GraphRecord, type GraphStore} from './graph/store.js';

export type CommandDeps = {
	store: GraphStore;
	log: Logger;
	web: {baseUrl(): string; status(): WebStatus};
	fileRoots?: readonly string[];
};

const LIST_MAX = 50;
const TITLE_CLIP = 40;

const subs: Subcommand[] = [
	{
		name: 'new',
		usage: 'interact graph new [--interactive] [--file <path>] [json]',
		description: 'Make a graph page and print its address',
		args: [{name: 'json', description: 'The graph as one quoted JSON word'}],
		options: [
			{name: '--interactive', description: 'Let the user edit the edges and press Done'},
			{name: '--file', value: '<path>', description: 'Read the graph JSON from a file (up to 256 KiB)'},
		],
		notes: [
			'JSON: {"title"?, "nodes": [{"id", "label"?, "size"?, "color"?}], "edges"?: [{"from", "to", "kind"?}]}',
			`Up to ${GRAPH_LIMITS.nodes} nodes and ${GRAPH_LIMITS.edges} edges; ids are 1 to 64 of letters, digits and _ . : -`,
			'size is 1 to 5 (default 2); kind is plain, directed or bidirectional (default plain)',
			`color: ${Object.keys(COLORS).join(', ')} or #rgb / #rrggbb (default blue)`,
			'Quote the JSON as one word; for a big graph write a file under /tmp and use --file',
			'One edge per pair of nodes; use bidirectional for both directions',
		],
	},
	{
		name: 'get',
		usage: 'interact graph get <id> [--json]',
		description: 'Show a graph and what the user changed',
		args: [{name: 'id', description: 'Graph id from "interact graph list"'}],
		options: [{name: '--json', description: 'Print the stored graph and the changes as JSON'}],
	},
	{name: 'list', usage: 'interact graph list', description: 'List the latest graphs'},
];

const usage = (message: string) => commandError('usage', message);

const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

const clip = (text: string, max: number): string => {
	const chars = Array.from(text);
	return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
};

const stateOf = (g: GraphRecord): string => (!g.interactive ? 'view only' : g.finishedAt !== undefined ? 'finished' : 'open');

function changeLines(diff: EdgeDiff): string[] {
	const part = (label: string, items: string[]): string => `${label}: ${items.length === 0 ? '(none)' : items.join('; ')}`;
	return [
		part('Added', diff.added.map(formatEdge)),
		part('Removed', diff.removed.map(formatEdge)),
		part('Changed', diff.changed.map(c => `${formatEdge(c.before)} => ${formatEdge(c.after)}`)),
	];
}

export function createCommand(deps: CommandDeps): Command {
	const {store, log, web} = deps;
	const roots = deps.fileRoots ?? ['/tmp', '/workplace', os.tmpdir()];

	const readGraphFile = async (file: string): Promise<string> => {
		const unreadable = commandError('invalid', 'Cannot read the file');
		let real: string;
		try {
			real = await realpath(path.resolve(file));
		} catch {
			throw unreadable;
		}
		const inside = await Promise.all(
			roots.map(async root => {
				try {
					const base = await realpath(root);
					return real === base || real.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
				} catch {
					return false;
				}
			}),
		);
		if (!inside.some(Boolean)) throw commandError('invalid', `The file must be under ${[...new Set(roots)].join(', ')}`);
		try {
			const info = await stat(real);
			if (!info.isFile()) throw commandError('invalid', 'The path is not a regular file');
			if (info.size > GRAPH_LIMITS.inputBytes) throw commandError('invalid', `The file is larger than ${GRAPH_LIMITS.inputBytes} bytes`);
			return await readFile(real, 'utf8');
		} catch (err) {
			if ((err as {kind?: string}).kind !== undefined) throw err;
			throw unreadable;
		}
	};

	const makeGraph = async (args: string[], ctx: CommandContext): Promise<void> => {
		let interactive = false;
		let file: string | undefined;
		const words: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const arg = args[i]!;
			if (arg === '--interactive') interactive = true;
			else if (arg === '--file') {
				const value = args[++i];
				if (value === undefined) throw usage('"--file" needs a path');
				if (file !== undefined) throw usage('Give "--file" once');
				file = value;
			} else if (arg.startsWith('--')) throw usage(`Unknown option: ${arg.slice(0, 64)}. See "interact graph help"`);
			else words.push(arg);
		}
		if (file !== undefined && words.length > 0) throw usage('Give either --file or the JSON, not both');
		if (words.length > 1) throw usage('Expected the graph as one word: quote the JSON');
		if (file === undefined && words.length === 0) throw usage('Usage: interact graph new [--interactive] [--file <path>] [json]');
		const text = file !== undefined ? await readGraphFile(file) : words[0]!;
		let input;
		try {
			input = parseGraphText(text);
		} catch (err) {
			throw commandError('invalid', (err as Error).message);
		}
		const record = await store.create(input, interactive);
		let open: string;
		try {
			open = `${web.baseUrl()}/interact/graph/${record.id}`;
		} catch {
			open = '(the web server address is not available)';
		}
		ctx.print(`Graph ${record.id} (${interactive ? 'interactive' : 'view only'}): ${record.nodes.length} nodes, ${record.edges.length} edges`);
		ctx.print(`Open: ${open}`);
		if (interactive) ctx.print(`When the user presses Done, the result goes to the open chat (API key chats) and "interact graph get ${record.id}" shows it.`);
		if (web.status().state !== 'running') ctx.print('The web server is not running in this process; the page opens while the yena app is open.');
	};

	const getGraph = async (args: string[], ctx: CommandContext): Promise<void> => {
		const asJson = args.includes('--json');
		const rest = args.filter(a => a !== '--json');
		const unknown = rest.find(a => a.startsWith('--'));
		if (unknown !== undefined) throw usage(`Unknown option: ${unknown.slice(0, 64)}. See "interact graph help"`);
		if (rest.length !== 1) throw usage('Usage: interact graph get <id> [--json]');
		const id = rest[0]!;
		if (!GRAPH_ID_RE.test(id)) throw commandError('invalid', 'Not a graph id');
		const g = await store.read(id);
		if (!g) throw commandError('not-found', 'No such graph');
		const diff = diffEdges(g.initialEdges, g.edges);
		if (asJson) {
			const {v: _v, ...stored} = g;
			ctx.print(JSON.stringify({...stored, diff}));
			return;
		}
		const state = !g.interactive ? 'view only' : g.finishedAt !== undefined ? `finished at ${stamp(g.finishedAt)} UTC` : 'interactive, not finished';
		ctx.print(`Graph ${g.id}${g.title ? ` "${clip(g.title, 80)}"` : ''}: ${state}`);
		ctx.print(`Nodes (${g.nodes.length}):`);
		for (const n of g.nodes) ctx.print(`  ${n.id}: ${n.label}`);
		ctx.print(`Edges (${g.edges.length}):`);
		for (const e of g.edges) ctx.print(`  ${formatEdge(e)}`);
		if (g.interactive) for (const l of changeLines(diff)) ctx.print(l);
	};

	const listGraphs = async (ctx: CommandContext): Promise<void> => {
		const all = await store.list();
		if (all.length === 0) {
			ctx.print('No graphs yet.');
			return;
		}
		const rows = all.slice(0, LIST_MAX).map(g => [g.id, clip(g.title ?? '-', TITLE_CLIP), g.interactive ? 'interactive' : 'view only', stateOf(g), String(g.nodes.length), String(g.edges.length), stamp(g.createdAt)]);
		const blocks: StyledBlock[] = [table(rows, {head: ['Id', 'Title', 'Mode', 'State', 'Nodes', 'Edges', 'Created']})];
		if (all.length > LIST_MAX) blocks.push(line(span(`Showing ${LIST_MAX} of ${all.length}.`, {tone: 'muted'})));
		printStyled(ctx, blocks);
	};

	const graphCommand = async (args: string[], ctx: CommandContext): Promise<void> => {
		const [sub, ...rest] = args;
		switch (sub) {
			case undefined:
				if (ctx.showHelp) ctx.showHelp(['graph']);
				else ctx.print('interact graph <subcommand>');
				return;
			case 'new':
				return makeGraph(rest, ctx);
			case 'get':
				return getGraph(rest, ctx);
			case 'list':
				if (rest.length > 0) throw usage('Usage: interact graph list');
				return listGraphs(ctx);
			default:
				throw usage(`Unknown subcommand: ${sub.slice(0, 64)}. See "interact graph help"`);
		}
	};

	return {
		name: 'interact',
		description: 'Web pages the assistant makes for you',
		usage: 'interact <subcommand>',
		args: [{name: 'subcommand', description: 'graph'}],
		agent: 'safe',
		subcommands: [
			{
				name: 'graph',
				usage: 'interact graph <subcommand>',
				description: 'Graphs to view and edit in the browser',
				args: [{name: 'subcommand', description: 'new, get or list'}],
				agent: 'safe',
				subcommands: subs.map(s => ({...s, agent: 'safe' as const})),
			},
		],
		async run(args, ctx) {
			const [sub, ...rest] = args;
			if (sub === undefined) {
				if (ctx.showHelp) ctx.showHelp();
				else ctx.print('interact <subcommand>');
				return;
			}
			if (sub !== 'graph') throw usage(`Unknown subcommand: ${sub.slice(0, 64)}. See "interact help"`);
			log.debug('interact graph command', {sub: rest[0] ?? ''});
			return graphCommand(rest, ctx);
		},
	};
}
