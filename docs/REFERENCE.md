# Celsus OS, full reference

A second brain OS over an Obsidian vault: an entity and title normalizer, missed connections, a duplicate finder, and a local app where you read the graph and answer decisions as flashcards. Jev (TypeSafe, via OpenRouter) decides, an LLM narrates, a rule store learns from every answer. Testing guide: `TESTING.md`. Spec: `Efforts/Active/Celsus OS/Celsus OS - Build Spec.md` in the Celsus vault.

Quick start: `node cli.ts setup`, `node cli.ts doctor`, `node cli.ts run`, `node cli.ts serve`, then open http://localhost:3043.

Zero dependencies. Node 22.18 or newer runs the `.ts` files directly (type stripping). Nothing here edits the vault; every run writes to `Efforts/Active/Celsus OS/runs/<date>/`.

```
node normalize-entities.ts                       dry run: rules and shortlists, no network
node normalize-entities.ts --live                shadow run: Jev judges the shortlist (names and titles only leave the machine)
node normalize-entities.ts --live --limit 200 --min-count 3 --concurrency 8
VAULT_PATH=/path/to/vault node normalize-entities.ts
```

Key handling: `JEV_KEY` env var, or a file at `~/.jev_key` (override with `JEV_KEY_FILE`). The key is never stored in the vault, this folder, or a scheduled task prompt.

| File | Role |
|---|---|
| `vault.ts` | Walk the vault, parse frontmatter and wikilinks, task `[c:]` and `[e:]` tags. Skips archives, `studio/`, `runs/`, dotfolders |
| `glossary.ts` | Canonical entity registry: one entity per note, names from title, basename, aliases and the link policy registry. Structural files excluded. Precedence rules for exact collisions |
| `match.ts` | Local candidate generator: exact, spacing, initials, spelling (Damerau Levenshtein), token spelling, contains, tokens. Top five above 0.55 |
| `jev.ts` | OpenRouter Decisions client with timeout, retries, bounded concurrency. Failures are returned, never thrown across a batch |
| `metrics.ts` | Graph metrics before and after a resolution map: resolved links, phantom targets, orphans, isolated notes, fragmented entities, top hubs |
| `normalize-entities.ts` | The runner. Collect mentions, resolve by rule, shortlist, ask Jev, write the run folder |

Run folder contents: `glossary.json`, `mentions.json`, `resolutions.json` (alias key to canonical note path, the thing an indexer applies), `decisions.jsonl` (one row per Jev call with the full distribution), `baseline.json`, `gold-template.csv` (fill `human_label_id`), `report.md`.

## Owner edges and ghosts

`node suggest-owners.ts --live` asks Jev, for every active effort hub with no `company` in its frontmatter, which company or client owns it (state: title, tags, names of linked notes). Output `suggested-edges.json`, edge kind `owner_suggested` with band `auto` (p at or above 0.9) or `review`. The indexer draws these dashed; a human wikilink is never confused with one.

`resolutions.json` also carries `ghosts`: entities that are linked two or more times but have no note, with the `mention_type` Jev assigned. Studio renders them as ghost nodes and lists them as missing notes.

Origin: both ideas came from the Python prototype built in parallel on 24 September (`_to_delete/celsus-os-proto-2026-09-24/`), folded here so one code path feeds the studio.

## Setup, narration, missed connections, duplicates

| Command | What it does |
|---|---|
| `node setup.ts` | First run. Asks for the OpenRouter key, the classifier (Jev by default) and an LLM (blank picks a free default; `stealth/space-bunny-alpha` while its tag is live, then DeepSeek V4 Flash). Writes `~/.celsus-os/config.json` |
| `node narrate.ts "<entity>"` | The LLM writes the authored view for one entity from a names-only dossier. Output in `runs/<date>/narrations/`. Precompute per run; the reasoning models take 20 to 70 seconds |
| `node suggest-links.ts --live` | Missed connections. Entity pairs that never link but share entity neighbours, judged by Jev as part of, related (worth a link), siblings or unrelated. Output `suggested-links.json` |
| `node find-duplicates.ts` | Same name or near name notes. Picks the canonical by precedence and says delete_safe, merge_then_delete, rename, alias_conflict or different_thing. Output `duplicates.json` and `duplicates.md`. Never deletes |

Model notes from the 25 September test: Space Bunny Alpha is free, multimodal (read a slide correctly) and a reasoning model, so `max_tokens` must cover its thinking (6,000 is set) and the `reasoning` request parameter makes the provider return 502, so it is not sent. DeepSeek V4 Flash gave the better narration for USD 0.0003.

## Notes, archive, Laya

| Command or endpoint | What it does |
|---|---|
| `node cli.ts restart` | Stops the server on 3043 (pid file) and starts it again. Same as `lsof -ti:3043 \| xargs kill; node cli.ts serve` |
| `POST /api/note/draft` | Missing notes, Create note. You give a name, a kind and two lines of context; Laya (the configured LLM, local or OpenRouter) fills the vault template from `Other/Templates`, links known entities, and lists what it still needs. Jev then judges from field names only (never prose) whether it is complete enough to save. Nothing is written |
| `POST /api/note/save` | Writes the edited draft to the kind's folder (`Atlas/People`, `Atlas/Companies`, `Atlas/Clients`, `Atlas/Products`, `Efforts/Active/<Name>/<Name>.md`, `Inbox`). Refuses to overwrite unless asked |
| `POST /api/dup/archive` | Duplicates, Archive. Moves the copy to `Other/Archive/Deleted/<date>/` and appends a line to `manifest.jsonl` there. One click for `delete_safe`; other verdicts need a second click (force). Effort hubs are never moved. The walker skips `Other/Archive`, so the note leaves the graph but stays on disk |
| `POST /api/dup/restore` | Puts an archived note back where it was |
| `POST /api/ask` with `history` | Follow up questions. The UI sends the subject (the node or entity you are talking about) and the last turns; the server keeps the subject first in the dossiers so "who introduced them?" stays about the same company |

Laya is trained continuously from the same store the rules live in. After every answer `policy.ts` rewrites `runs/laya/system.md` (who she is, the vault layout, your standing and forming rules, and the body of `Efforts/Active/Celsus OS/Laya Best Practices.md`), `runs/laya/train.jsonl` (one chat example per human answer and per rule note) and `runs/laya/Modelfile`. To refresh the local model:

```
ollama create celsus-laya -f "<vault>/Efforts/Active/Celsus OS/runs/laya/Modelfile"
```

then in Settings, Models choose Local model with endpoint `http://localhost:11434/v1` and model `celsus-laya`. The base model is `llama3.1`; set `"layaBase": "llama3.2"` (or any tag you have pulled) in `~/.celsus-os/config.json` to change it. `train.jsonl` is in the OpenAI chat format, ready for a LoRA run when there are a few hundred answers.

## Mascot

`ui/mascot.js` draws original pixel characters from 18 x 20 matrices (no assets): five species (owl, cat, fox, bunny, robot) in nine looks, picked in Settings, General with live previews. States: idle, think, speak, ask, celebrate, error, sleep, driven by app events. To add a look, add a palette entry; to add a species, add a matrix (rows 5 to 7, columns 5 to 7 and 12 to 14 are the eyes). To use a codex pet style sprite sheet you hold a license for, put it in `ui/pets/` and create `ui/mascot.json`:

```
{ "spritesheet": "/ui/pets/my-pet.webp", "frameWidth": 192, "frameHeight": 208,
  "states": { "idle": {"row": 0, "frames": 8}, "think": {"row": 2, "frames": 8}, "speak": {"row": 3, "frames": 8}, "ask": {"row": 1, "frames": 8}, "celebrate": {"row": 5, "frames": 8}, "sleep": {"row": 7, "frames": 8} } }
```

Community pets from awesome-codex-pet are non commercial only; do not ship one in a team build.
