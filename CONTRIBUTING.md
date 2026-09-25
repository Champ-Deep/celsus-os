# Contributing to Celsus OS

## Dropping in a new front end

The app is served by `serve.ts` from two static files: `ui/index.html` (all CSS and JS inline) and `ui/mascot.js`. A redesign replaces those files and nothing else. The server reads `index.html` on every request, so a change shows on reload without a restart.

The contract the front end works against is documented for designers and builders in the vault note `Efforts/Active/Celsus OS/Frontend Handoff.md` (also published as a page). In short:

- Every endpoint, its shape, latency and error cases: `GET /api/state`, `/api/graph`, `/api/search`, `/api/narration`, `/api/ghosts`, `/api/duplicates`, `/api/archive`, `/api/config`, `/api/keycheck`, `/api/policy`; `POST /api/answer`, `/api/undo`, `/api/ask` (with `focus` and `history`), `/api/narrate`, `/api/rule-note`, `/api/note/draft`, `/api/note/save`, `/api/dup/archive`, `/api/dup/restore`, `/api/config`.
- The view block allowlist the narrator writes and the front end renders: heading, prose, stats, entities, table, list, decision, decided. Anything else is dropped by the server, so do not render unknown types.
- The node grammar is fixed: icon = kind, size = inbound (log), ring = information level, halo = act now, dashed = missing note, brass ring = selected or centre.
- Six screens: Graph, Decide, Missing notes, Duplicates, Rules, Settings. Every state per screen is enumerated in the handoff.

Keep the front end dependency free (no build step) unless a team owner decides otherwise; the whole point of the package is `git clone` and run.

## Adding a mascot

`ui/mascot.js` draws every character from an 18 by 20 matrix. Rows 5 to 7, columns 5 to 7 and 12 to 14 are the eyes and are swapped per state. Add a look by adding a palette entry (name, species, and the ten letter colours); add a species by adding a matrix. Community sprite sheets from awesome-codex-pet are non commercial and are not shipped; a licensed sheet can be dropped into `ui/pets/` and described in `ui/mascot.json`.

## Adding a decision type

Cards are built in `serve.ts` (`buildCards`). A new card kind needs an id prefix, a pattern string (this is what the rule store learns on), a question, options with stable keys, a `why` line, `ctx` chips, the node ids it concerns, and `p`. `policy.ts` `describePattern` turns the pattern into words for the policy note and the Jev briefing.

## Style

No em dashes or en dashes anywhere, in code comments or copy. British or Indian English is fine. Keep files dependency free; Node 22.18 or newer runs the TypeScript directly, so use `import type` for interfaces.

## Running against a test vault

`VAULT_PATH=/path/to/vault node cli.ts serve --port 3044` runs a second instance against another vault on another port without touching your config.
