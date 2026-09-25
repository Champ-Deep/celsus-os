# Testing Celsus OS

Ten minutes on a Mac. Nothing here edits a note; every answer lands in `runs/labels.jsonl` and `runs/rules.json` inside the vault's `Efforts/Active/Celsus OS/` folder.

## 1. Requirements

Node 22.18 or newer (`node --version`; if missing or older: `brew install node`). An Obsidian vault on disk. An OpenRouter API key.

## 2. Get the code

Until the repo is pushed, the code lives in the vault at `studio/scripts/celsus-os`. Once pushed:

```
git clone https://github.com/Champ-Deep/celsus-os
cd celsus-os
```

## 3. Setup, then check

```
node cli.ts setup       # key, classifier (Jev), LLM (blank picks a free default), vault folder
node cli.ts doctor      # checks: node, vault, config, run folder, one Jev call, one LLM call
```

Config is written to `~/.celsus-os/config.json`, outside the vault and outside the repo.

## 4. First pass over the vault

```
node cli.ts run         # normalize (about 90 s on 2,900 notes), owner edges, missed links, duplicates. Under 10 cents.
```

Outputs land in `<vault>/Efforts/Active/Celsus OS/runs/<date>/`. `report.md` is the summary.

## 5. Open the app

```
node cli.ts serve       # http://localhost:3043
```

What to try, in order:

1. Graph. The ask bar starts with the subject chip ("whole vault" until you click a node or pick one). Type an entity (SPAN Global Services, Hemang, Champ IQ), Enter. The map fills the screen; the entity panel (top right) and the authored view (bottom left) float, drag them by their header, collapse with the button. Meetings and docs are off by default, toggle the chips. Drag a node; neighbours follow on springs. Double click pins. Wheel zooms. Labels show for the centre, the top ten and whatever you hover; "All labels" turns the rest on.
2. Ask. Map draws the graph around a note title (it tells you if the text is not a title). Ask always asks the model: a question, or a bare name, which becomes "tell me about X". Up and down arrows move through the suggestions, Enter picks. The answer appears in the owl bubble as blocks (heading, prose with links, stats, entity cards, decision cards you can answer in place). The map does not jump; if the subject is not on the current graph there is a Map button. Under every answer is a follow up box with the subject as a chip ("about Epicor"); ask "who introduced them?" and it stays about Epicor. Click the chip to drop the subject. 5 to 70 seconds depending on the model; every ask is logged to `runs/asks.jsonl`.
3. Decide. One card at a time, keys 1 to 4. Watch the right panel: after five consistent answers on the same pattern the rule goes auto and future cards of that shape are decided for you (with undo). The top bar shows cards per 100 judged.
4. Missing notes. Ranked by links. Create note opens a small form: name, kind, two lines of what you know. Draft with Laya fills the vault template, links known entities and lists what it still needs; Jev says whether it is complete enough. Answer the questions and draft again, or edit the text and Save to vault. New note at the top of the screen starts from blank. Ghost nodes on the graph have the same button.
5. Duplicates. delete_safe rows have an Archive button: the copy moves to Other/Archive/Deleted/<date> and leaves the graph. Other verdicts show Archive anyway and ask for a second click. Rename rows (effort hubs) have no button. The Archived list at the bottom restores any move. Nothing is ever deleted from disk by the app.
6. Subject. The chip at the left of the ask bar and in the bubble is what follow ups are about. Click it to drop the subject, and it turns into a picker: type a name, choose from the list, and the subject is set (and selected on the graph when it is there). Settings, Visuals has a Graph look switch (tinted, glow, discs) and Settings, General a mascot grid with live previews.
6. Rules. What the store learned, with support and confidence, and the Laya box: how many training examples exist and the one ollama command that refreshes the local model.
7. Node click. The bubble shows the node: kind, links, completeness, its pending decisions as cards you can answer, its closest neighbours as chips (click selects them on this graph, no recentring), the cached narration if there is one, and buttons: Write with the model, Map around this, Open in Obsidian or Create note.

Optional: `node cli.ts narrate "SPAN Global Services"` caches an authored view that shows under the graph (20 to 70 s depending on the model).

## 6. What to report back

The card you disagreed with and why. Any node whose size, ring or halo felt wrong. Any duplicate the finder got wrong. Time the run took on your machine and vault size.

## What an answer does

Each answer is appended to `runs/labels.jsonl` with the card's pattern, updates `runs/rules.json` (support, confidence, auto at 0.90 with 5 cases), and rewrites `Efforts/Active/Celsus OS/Decision Policy.md`, a readable policy with standing rules, forming rules and recent answers. The next `run` reads the labels (a settled mention is never asked again, a merge you confirmed is applied to the resolution map) and sends the standing rules to Jev as part of every state object, so the classifier is briefed with how you decide.

## Known limits in this build

Whole vault shows the most linked entities (Max nodes in Settings, Visuals); an entity shows its neighbourhood. Space Bunny Alpha is slow for narration; DeepSeek V4 Flash is the better default if you have a few cents of credit.
