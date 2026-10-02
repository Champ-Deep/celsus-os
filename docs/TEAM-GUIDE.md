# Celsus OS: the team guide

For a teammate who knows Obsidian and does not want to become a programmer. Everything below was
read out of the code in this repository. Where a number is an estimate rather than a measurement, it
says so.

## What this thing does

Celsus OS reads a folder of markdown notes and maps it as a knowledge graph: which notes exist, which
ones link to which, and which names refer to the same real world thing. It sends only names and titles
to a classifier that returns a probability for every judgement it makes. Anything the classifier is not
sure about becomes one short question at a time, you answer with a single key press, and the app
learnes how you decide so it stops asking. Every note body stays on your machine.

## Before you start

You need three things, and only the first one costs money.

| Need | Why | Check it |
|---|---|---|
| Node 22.18 or newer | The app is TypeScript and Node runs it directly. There is no build step and no `npm install`. | `node -v` |
| git | The one-line installer clones the app with it. | `git --version` |
| One OpenRouter API key | Pays for the classifier and, unless you run a local model, the writer. | <https://openrouter.ai/keys> |

Node 22.18 is the floor because that is the first release where Node strips TypeScript types by
default. `cli.ts` refuses to start on anything older and prints the version it found.

The key looks like `sk-or-v1-...`. One key per person. There is no shared account and no team key.

## The four commands

### 1. Install

```sh
curl -fsSL https://raw.githubusercontent.com/Champ-Deep/celsus-os/main/install.sh | sh
```

That URL is the home of the project and it works. The installer checks git and Node, refuses to
continue on Node older than 22.18, clones into `~/.celsus-os/app`, symlinks `celsus` into
`~/.local/bin`, and prints the line to add to your shell profile if that folder is not already on
your PATH.

If you would rather not pipe a script into a shell, clone it and run the commands with `node cli.ts`
instead of `celsus`:

```sh
git clone https://github.com/Champ-Deep/celsus-os.git
cd celsus-os
```

You can override four installer variables if you need to: `CELSUS_REPO` (clone from somewhere else),
`CELSUS_HOME` (install folder), `CELSUS_BIN` (where the `celsus` symlink goes), and `CELSUS_VERSION`
(the git ref to clone, `main` by default).

### 2. `celsus setup`

Writes `~/.celsus-os/config.json`. See the next section for how to answer.

### 3. `celsus run`

One full pass over the folder. In order: `normalize-entities`, `suggest-owners`, `suggest-links`,
`find-duplicates`. The first three make classifier calls, the last one is local. The repo's own
estimate is about 4 minutes for 3,000 notes. Output lands in a dated run folder inside the vault and
`report.md` is the summary.

### 4. `celsus serve`

Boots the local app on <http://localhost:3043>. `celsus open` opens it in your browser,
`celsus restart` kills whatever holds port 3043 and starts it again.

### The rest of the command line

Verified from `cli.ts`:

| Command | What it does |
|---|---|
| `celsus doctor` | Checks the machine end to end, one line per check |
| `celsus restart` | Frees port 3043 and serves again |
| `celsus open` | Opens the app in your browser |
| `celsus update` | `git pull --ff-only` in the install folder |
| `celsus narrate "<entity>"` | Caches one authored view for one entity |
| `celsus links` | The missed-connections pass only |
| `celsus owners` | The owner-edge pass only |
| `celsus duplicates` | The duplicate finder only |
| `celsus setup \| doctor \| run \| serve` | Print the help text and exit |

Every command takes `--dry`, which drops the `--live` flag where a script has one, so those passes run
without making any network call. `serve` takes `--port`. `open` and `restart` read `--port` too.

## Answering `celsus setup` well

`setup.ts` asks four questions. The answers are written to `~/.celsus-os/config.json`, which is
outside the vault and outside the repo.

**1. The OpenRouter API key.** Paste it. The setup calls the OpenRouter model list with the key and
tells you how many models it can see. If that call fails, the key is still saved and `celsus doctor`
will verify it later, so a network hiccup here is not a reason to stop.

**2. Call the classifier direct from TypeSafe with your own key?** The answer for almost everyone is
no. Say no and the classifier is called through OpenRouter, which is the one-key path. If you
somehow have a TypeSafe key, say yes and paste it, and calls go to TypeSafe's own endpoint instead.
Only the source of the classifier call changes; the model stays the same.

**3. The writing model, and whether it runs locally.** This is the only question with a real trade
off. The setup probes three local endpoints before it asks: Ollama on port 11434, LM Studio on 1234,
and any OpenAI-compatible server on 8080. If one of them answers, it is offered as the writer and
narration runs on your machine at no cost. If nothing answers, you get a free hosted model by default.
Press Enter to accept it. Type a model id to override. The default is `stealth/space-bunny-alpha`
while its tag is live, then `deepseek/deepseek-v4-flash`, then `openrouter/omni`, then
`google/gemini-2.0-flash-exp:free`. The repo's own testing note says DeepSeek V4 Flash produced the
better narration of those two.

**4. The folder to map.** An Obsidian vault, or honestly any folder of markdown. Setup guesses: your
existing config, then `VAULT_PATH`, then a folder called `Celsus` in your home directory if it has
a `.obsidian` folder, then the current directory. It prints how many markdown files it found, so check
that number before you walk away. If it is zero, you pointed at the wrong folder.

`setup.ts` also takes flags, which is how CI and scripted installs use it: `--key`, `--typesafe-key`,
`--classifier`, `--llm`, `--llm-base-url`, `--vault`, and `--yes` to take every default and never
prompt. Passing any of `--yes`, `--vault` or `--key` makes it non-interactive.

After setup, run `celsus doctor`. It should say all checks passed. Eight checks run, and the two that
can fail on a fresh machine are the latest-run check (nothing has been run yet) and the
classifier-provider check (no key found). Add `--no-network` to skip the two live model calls, and
`--json` if you want the result as JSON.

## Reading the app, screen by screen

The left rail has six screens plus a Settings gear. Each screen has a count next to its name, so you
can see from the rail whether anything needs you.

### Graph

The whole folder as a map, or one entity's neighbourhood when you type a name and press Map. Node
size is how many links point at a note, on a log scale. The ring is information level. A halo means a
decision is waiting. A dashed outline is a ghost: something referenced that has no note. Drag nodes,
wheel to zoom, double click to pin. Above the canvas: hop count (1 or 2), kind filters (People,
Companies, Clients, Efforts, Products, Meetings, Docs), a toggle for suggested edges, and a toggle for
all labels.

The bar at the top does two things depending on what you type. A known name maps it. Anything else is
sent as a question. The subject chip on the left is what follow ups are about, so "who introduced
them?" stays about the company you were looking at.

The owl is the pixel mascot. Five species, nine looks, pick yours in Settings. It answers in small
blocks, not walls of text: headings, prose with wikilinks, stat tiles, entity cards, tables, lists,
and decisions you can take without leaving the answer.

### Decide

One card at a time. Why you are seeing it, four answers, keys 1 to 4. The recommended answer is
prefilled when the classifier is confident. Below the card is what the rule store has learned so far,
and the decisions it has already made for you, each with an undo. Undoing a decided card lowers the
rule that produced it.

A rule starts deciding on its own at confidence 0.90 with support 5. Those are the cards where you
can skip ahead: the answer is already recorded, and the label is written with the rule as its source.

### Health

The measured answer to "what is strong and what is missing". Every number on it is computed from the
folder and the latest run, not stored as an opinion, so it moves when your notes move.

Top to bottom: the headline counts (notes, words, entities, how many links resolve, what share of
notes were touched in the last 30 days), then **strongest folders** and **weakest folders** ranked by
reachability, which is the share of a folder's notes that something else in the vault points at.
Reachability is the number that changes behaviour, because one orphaned folder can pull an average
looking vault down. Weakest only lists folders of three notes or more, so one stray file is not called
a problem. Then **every folder** with its counts, **what the map is made of** by kind, **most
referenced notes** (the hubs a link-following agent reaches first), **named but never written down**
(the ghosts, which are gaps nothing on disk can answer), and **what the classifier is unsure about**,
grouped by the shape of the question. A long bar there is a decision you keep making by hand, and
therefore a candidate for a standing rule you could write once.

### Missing notes

Linked from your notes, but no note exists, ranked by how many links point at each one. The icon is
the type the classifier assigned. Create note asks you for two lines of context, the writing model
drafts the note from your vault template in `Other/Templates` and links what it recognises, the
classifier checks whether the required fields are filled, and you answer whatever is still open before
saving. Nothing is written to your vault until you press save.

New notes go to the folder for their kind: `Atlas/People`, `Atlas/Companies`, `Atlas/Clients`,
`Atlas/Products`, `Efforts/Active/<Name>/`, or `Inbox` for an untyped note.

### Duplicates

Same-name and near-name notes, with the canonical one chosen by precedence and a verdict:
`delete_safe`, `merge_then_delete`, `rename`, `alias_conflict` or `different_thing`. Archive moves the
copy to `Other/Archive/Deleted/<date>/` and appends a line to `manifest.jsonl` in that folder. The
walker skips `Other/Archive`, so the note leaves the graph and stays on disk. Restore puts it back
where it was. Effort hubs are never moved. **Nothing is ever deleted.**

### Rules

What the store has learned. Each pattern with its answers and support count. You can attach a note in
your own words to any rule, and it travels into three places: the Decision Policy note in your vault,
the briefing sent to the classifier on the next run, and the training set for the local writing model.

### Settings

Three tabs.

**General.** Theme (dark, light, glass), edge margin, mascot, home entity, and the vault path it is
reading.

**Models.** Execution: External API or Local model. The OpenRouter key field, the classifier shown
read-only, and the writing model. Choosing Local model exposes an endpoint field (`http://localhost:11434/v1`
for Ollama, `http://localhost:1234/v1` for LM Studio) and a model name field. The note under the form
says the key stays in `~/.celsus-os/config.json`, and that Jev always runs through OpenRouter while
only the narrator can be local.

**Visuals.** Graph rendering: link distance, and the three looks the README mentions (tinted, glow,
discs).

## What it costs

One OpenRouter key, and small amounts on it.

| Item | Cost |
|---|---|
| Classifier (`typesafe/jev-1.13` via OpenRouter) | The README says about two cents for a whole vault pass. `TESTING.md` budgets the whole `celsus run` at under ten cents. Both are the repo's own figures from testing, not a metered guarantee. |
| Writer, free default | Free while the model's tag is live. Free model ids are listed in the previous section. |
| Writer, if you pick a paid one | Priced by OpenRouter per your account. `docs/REFERENCE.md` records USD 0.0003 for one narration with `deepseek/deepseek-v4-flash`. |
| Writer, local | Zero. Nothing is billed. |
| Running the app | Free. It is a local process on your machine. |

You can watch the real spend per run: `celsus run` prints a `cost` figure for the passes that call
the classifier, and it is written into `suggested-links.json` and `suggested-edges.json` in the run
folder.

## What leaves your machine, and what does not

This is the part worth being precise about, because "your notes never leave your machine" is only
true up to what a model needs in order to answer.

**The classifier (Jev, via OpenRouter) receives names and titles. It never receives note bodies.**

Verified from the four passes:

| Pass | What is sent |
|---|---|
| `normalize-entities` | The mention, up to five other spellings of it, the mention's kind, how many times it occurs, up to five folder names it was seen in, and up to twelve of your standing rules. Candidate criteria are entity titles and kinds. |
| `suggest-links` | For each pair: the two titles and kinds, up to eight shared neighbour titles, the shared count, and how the pair was found. |
| `suggest-owners` | The effort title, its tags, and the titles of the notes it links to. |
| `find-duplicates` | No model calls. This pass is entirely local. |
| Note completeness check (`notes.ts`) | Which required field names are filled, which are empty, the body word count, and how many of your answers you gave. Field names, never prose. |

Folder names are part of the state in the first pass. That is worth knowing: the classifier sees up to
five folder names per mention. If a folder name is itself sensitive, that is the one place it goes.

**The writer (the narration and drafting model) receives dossiers. It receives no note bodies.**

Verified: a dossier is entity titles, kinds, path, aliases, inbound link counts, the titles and kinds
of linked neighbours, suggested owner edges with their probabilities, a note's word count, and the
names of its frontmatter fields. The question you typed, and the previous turns of the conversation,
also go to it. When you draft a new note, the two lines of context you type go to it, because that is
what it is drafting from.

If the writer is set to a local endpoint, none of it leaves the machine.

**Nothing else is transmitted.** The graph, the runs, the rule store, the label log and the app itself
are all local. The server binds to localhost and serves only your own browser.

**What is written into your vault.** Three things: notes you save from Missing notes, the
`Decision Policy.md` note rewritten after every answer, and archive moves. Plus the run folder itself.
Nothing else in your notes is edited.

## Where things live on disk

| What | Where |
|---|---|
| Your key and settings | `~/.celsus-os/config.json`, outside the vault, created mode 0600 inside a directory created mode 0700 |
| Run output | `Efforts/Active/Celsus OS/runs/<date>/` if your vault has an `Efforts/Active` folder, otherwise `Celsus OS/runs/<date>/` at the vault root |
| The policy note | `Decision Policy.md` in the same Celsus OS folder |
| Your answers | `runs/labels.jsonl`, one line each |
| The rule store | `runs/rules.json` |
| Local model training | `runs/laya/`: `system.md`, `train.jsonl`, `Modelfile` |
| Archived duplicates | `Other/Archive/Deleted/<date>/`, with `manifest.jsonl` |

To refresh the local writing model after you have answered a few cards:

```sh
ollama create celsus-laya -f "/path/to/your/vault/Efforts/Active/Celsus OS/runs/laya/Modelfile"
```

Then point Settings, Models at `http://localhost:11434/v1` with model `celsus-laya`. The base model
defaults to `llama3.1`; change it with `"layaBase"` in `~/.celsus-os/config.json`.

## When something goes wrong

Start with `celsus doctor`. It names the failing check instead of guessing, and `--json` gives you the
same thing machine-readably.

| Symptom | Likely cause and fix |
|---|---|
| `celsus: needs Node 22.18 or newer` | Node is too old. `brew upgrade node`, or `nvm install 22`. |
| `celsus: command not found` after installing | `~/.local/bin` is not on your PATH. Add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` and open a new terminal. |
| `no vault at <path>` | `VAULT_PATH` is wrong, or you never ran `celsus setup`. |
| `no config; run celsus setup` | Setup has not been run, or `CELSUS_CONFIG` points somewhere else. |
| The install one-liner does nothing | The repository is not published yet. Clone it instead and use `node cli.ts`. |
| The Graph is empty | `celsus run` has not been run against this folder yet. |
| Decide count is stuck | Run `celsus run` again, or open a terminal and look at the deck. |
| Port 3043 already in use | `celsus restart`. |
| The writer is slow or the answers are thin | Switch to a faster or better model in Settings, Models. `TESTING.md` notes the free default is a reasoning model and takes 20 to 70 seconds per narration. |

One rough edge worth knowing: the app's own state folder is resolved from your vault's shape, but
`serve.ts` still hardcodes the `Efforts/Active/Celsus OS/runs` path for the label log and the rule
store. On a vault with no `Efforts/Active` folder those two land in a different place from the policy
note. Everything works, the files just end up in two folders. If that bites you, say so and it gets
fixed.

## Getting help, and reporting a problem

Repo issues and pull requests go to the GitHub repository once it is published. Until then, ask the
owner directly.

When you report something, include the output of these three commands. They are the fastest route to
a fix and they contain no note content:

```sh
node cli.ts doctor --json
node -v
git -C ~/.celsus-os/app log --oneline -3
```

Say what you did, what you expected, what happened, and whether it happens every time or once. If the
Graph or a card looks wrong, a screenshot is worth a lot. If it is about privacy or your key, say so
plainly and it goes straight to the owner rather than into a public issue.

## Honest status

Version 0.2.0. The project has had no independent security
review and no independent accuracy review of the classifier. The cost figures quoted above are the
repo's own testing notes, not a billing guarantee. Everything described here was read from the code in
this repository, and the install and end-to-end steps in `.github/workflows/ci.yml` are run on every
push on Linux and macOS on Node 22 and 24.