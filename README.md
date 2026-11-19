# interact

Web pages the assistant makes for you. The first kind is a graph: nodes and edges drawn in your browser, optionally editable, with a Done button that tells the open chat what you changed.

## Commands
| Command | What it does |
|---|---|
| `interact graph new` | Makes a graph page from JSON (inline or `--file`) and prints its address; `--interactive` lets you edit the edges |
| `interact graph get` | Shows a graph, the edges you changed and, with `--json`, the stored record |
| `interact graph list` | Lists the latest graphs |

All commands are `safe` for the assistant. See `help interact` for the usage, the JSON schema, the colours and the limits.

Graph JSON: `{"title"?, "nodes": [{"id", "label"?, "size"?, "color"?}], "edges"?: [{"from", "to", "kind"?}]}`. Up to 500 nodes and 2000 edges, 256 KiB of input; ids are 1 to 64 characters of letters, digits and `_ . : -`; `size` 1 to 5; `kind` is `plain`, `directed` or `bidirectional`; one edge per pair of nodes. Pass the JSON as one quoted word, or write a file under `/tmp` or `/workplace` and use `--file`; give one of them, not both.

## The page
`<web address>/interact/graph/<id>` (the address is printed by `graph new`; the web server runs while the yena app is open). Drag nodes, drag empty space to pan, scroll to zoom. In an interactive graph: Connect (or Shift+drag) joins two nodes, click an edge and press Delete to remove it, keys 1, 2, 3 pick the edge kind, Done finishes. Changes are saved half a second after you make them.

When you press Done, a summary of the added, removed and changed edges goes to the open chat as a message from this module. The chat accepts it only when it runs on an API key; otherwise, or when no chat is open, the page says so and `interact graph get <id>` shows the result.

## Environment
None (the web address and port come from the `web` module).

## Data
`<YENA_DATA>/interact/graphs/<id>.json` (folder 0700, files 0600): the nodes, the first edges, the current edges and the state. The newest 100 graphs are kept; older ones are removed when a new one is made.

## Events
None.

## Dependencies
`web` (the pages), `chat` (`postToChat`, the result message), `core` (the text kit for command output).

## Limits and known risks
- The graph id (96 random bits) is the only protection of a page until access protection exists (SEC-15); anyone who reaches the web port and knows the id can open or edit that graph.
- Page requests that change data must be `application/json`, which a browser sends cross-origin only after a preflight that web refuses.
- Text from the graph (labels, titles) is drawn on a canvas and never inserted as HTML; control and bidirectional characters are refused.
- The page uses only same-origin scripts and styles (web's Content-Security-Policy forbids inline scripts).

## Development
`dev check interact` (run inside the yena tree; `tsc` and `tsx` come from `/app/node_modules`).
