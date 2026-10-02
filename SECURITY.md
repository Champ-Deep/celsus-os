# Security

Celsus OS reads a folder of markdown notes and sends names and titles to a classifier, plus small
dossiers of names, kinds and counts to a writing model. It holds one API key. This document says where
that key lives, what crosses the network, and what does not.

**Celsus OS has not had an independent security review.** Nothing here is a compliance claim. Read
this page as an accurate description of the code as written, not as a guarantee.

## The key

### Where it lives

`celsus setup` writes `~/.celsus-os/config.json`. That is outside your vault, outside the app
folder, and outside any git repository. The directory is created mode `0700` and the file mode
`0600`,
so on a multi-user machine other accounts cannot read it.

Override the path with the `CELSUS_CONFIG` environment variable. That is how you run a second vault
with a second config, and how CI points at a throwaway config.

### What never happens to it

| Never | Why |
|---|---|
| Written into the vault | The config path is outside the vault by construction |
| Written into the app folder or the repo | Same reason, plus the repo's `.gitignore` excludes `.celsus-os/` |
| Committed to git | Nothing in the repo reads the config as a build input, and the file lives in your home directory anyway |
| Sent to the classifier or the writer | Keys travel only in the `Authorization` header of the API call they authenticate |
| Printed by `celsus doctor` | Doctor prints the classifier and writer model names and the config path, never the key |
| Shown in the app's Settings screen | The key field is a password input, and the API returns only the last four characters as `keyTail` |

If you think a key has leaked: revoke it at <https://openrouter.ai/keys>, then run `celsus setup`
again and paste the new one. Setup overwrites the old value in place.

### Two ways to supply a key

**On disk (normal).** `~/.celsus-os/config.json` via `celsus setup`.

**In the environment (CI, or no-disk preference).** Set `OPENROUTER_API_KEY`. `config.ts` reads it
when no config file exists and builds an in-memory config from it, so nothing is written to disk. It
also accepts `JEV_KEY`, and `JEV_KEY_FILE` pointing at a file outside the vault, as a fallback path
for the classifier client.

### The optional TypeSafe key

Setup asks whether to call the classifier direct from TypeSafe instead of through OpenRouter. If you
say yes, a `typesafeKey` goes into the same config file, with the same permissions, and calls go to
`https://api.typesafe.ai/v1/decisions` instead of OpenRouter's decisions endpoint. If the key is
absent, OpenRouter is used. `typesafeBaseUrl` can override the endpoint.

You do not need this key. The one-key path is OpenRouter for both roles.

### The local model path

If you set `llmBaseUrl` in the config, the writer is called at that endpoint instead of OpenRouter.
`llm.ts` sends `Authorization: Bearer local`, a placeholder, and never sends your OpenRouter key on
that request. Setup probes `localhost:11434`, `localhost:1234` and `localhost:8080` to find one.

## What crosses the network

Everything that leaves your machine, exhaustively.

**Outbound, to the classifier** (`https://openrouter.ai/api/alpha/decisions`, or the TypeSafe
endpoint): the mention, up to five other spellings, the mention's kind, an occurrence count, up to
five folder names the mention was seen in, up to twelve of your standing rules, and candidate titles
and kinds. For missed connections: two titles and kinds, up to eight shared neighbour titles, a
count, and a match method. For owner edges: a title, tags, and linked note titles. For the note
completeness check: required field names, which are filled, which are empty, a body word count, and
how many answers you gave.

**Outbound, to the writer** (`https://openrouter.ai/api/v1/chat/completions`, or your local
endpoint): a dossier of titles, kinds, paths, aliases, inbound link counts, neighbour titles and
kinds, suggested edges with probabilities, a note word count, frontmatter field names, your question,
the conversation turns so far, and, when you draft a note, the context you typed.

**Outbound, during setup:** `GET https://openrouter.ai/api/v1/models` with your key, to count the
models you can see. From Settings, `GET https://openrouter.ai/api/v1/auth/key`, to confirm a pasted
key works and to show its label, usage and limit.

**Outbound, during `celsus doctor`:** one classifier call and one writer call, both of which send
strings invented for the test (`Umashakar`, `Reply with the single word ready`). `--no-network`
skips both.

**Never leaves:** note bodies, note prose, graph geometry, the rule store, the label log, the run
output, `Decision Policy.md`, the config file, and your OpenRouter key as data rather than as a
credential.

**One nuance worth stating plainly:** the first pass sends up to five folder names per mention as
part of its state. Folder names are not note bodies, but if a folder name is itself sensitive, that is
where it goes.

**Inbound:** nothing. The local server binds to loopback, serves your browser, and pushes nothing to
anywhere. No telemetry, no analytics, no crash reporting, no update check. `install.sh` and
`celsus update` reach `github.com` over `git`, which is the only network access from those scripts.

## What is written to your vault

Exactly three things, plus its own run folder:

1. Notes you save from Missing notes.
2. `Decision Policy.md`, rewritten in full after every answer.
3. Archive moves, which relocate a file to `Other/Archive/Deleted/<date>/` and append a line to
   `manifest.jsonl` in that folder.

Nothing else in your notes is edited, and nothing is ever deleted from disk.

## The vault must not be in git or cloud sync while `Other/.secrets/` exists

This is the one rule in this document that belongs to your vault rather than to this app, and it is
the rule with the worst consequences if broken.

If your vault has an `Other/.secrets/` folder, treat the entire vault as containing live credentials.
Until that folder is gone:

| Do not | Because |
|---|---|
| `git init` the vault, or add it to any repo | Secrets enter git history, where they survive every future `rm` and are pushed to every clone and every fork |
| Put the vault in iCloud, Dropbox, Google Drive, OneDrive, or any other sync folder | Credentials sync to every device, including devices you no longer control, and land in provider-side copies you cannot revoke |
| Share the vault as a zip or a link | Same exposure, faster |
| Commit the app folder inside the vault | `install.sh` defaults to `~/.celsus-os/app`, outside the vault. If you cloned inside instead, that clone contains no key, but it does put a git repo inside your notes |

The safe arrangement, which is what `celsus setup` gives you by default: keep the vault in a local
folder that is not synced, keep the app at `~/.celsus-os/app`, and keep the key at
`~/.celsus-os/config.json`. All three are outside the vault, and the key is the only one with a
credential in it.

If a secret has already been committed or synced, rotating it is the fix. Rewriting history or
deleting files does not un-copy something that already left.

## What is not protected

Stated plainly so nobody assumes otherwise:

- **No independent review.** No security audit, no penetration test, no third-party review of any
  kind has been done on this code.
- **No classifier accuracy review.** The classifier's judgements have not been independently
  measured against a known-good answer set. Confidence values are the model's own, not a
  guarantee.
- **Your account is your own.** Each person uses their own OpenRouter key. A shared key means shared
  billing and shared revocation, and there is no support path for either.
- **Supply chain is git-only.** `install.sh` pipes a shell script from a URL into `sh`. It has no
  checksum and no signature. Read it before you run it, or clone and run `install.sh` yourself. It
  checks for git and Node 22.18, clones into `~/.celsus-os/app`, and symlinks into
  `~/.local/bin`. It writes nothing into your vault.
- **The local server has no authentication.** It binds to loopback, so anything on your machine can
  reach it and it can write notes through it. Do not port-forward it, and do not run it on a shared
  host. It refuses to overwrite an existing note unless asked, and archive never deletes.
- **Dependencies.** There are none at runtime. `package.json` has no `dependencies` block, and there
  is no `npm install` step. This removes the usual npm supply chain, and it does not remove the git
  one.
- **Markdown is not sanitised.** Note titles and frontmatter values flow into prompts and into
  generated output. If your folder contains adversarial content, treat model output as untrusted
  before you save it.

## Reporting a vulnerability

Report it to the repository owner directly rather than opening a public issue. Do not include a live
key, a real note body, or a real vault path in the report. `/path/to/your/vault` is enough to
describe a location.

Send: what an attacker could achieve, the shortest reproduction you have, which of the surfaces above
it touches, and whether it needs a key, a network position, or physical access. A revoked key is
always welcome to report quietly.

If a report turns out to expose a credential, rotate that credential first and say in the report that
you did, without quoting the old value.

Public disclosure is the owner's call, after a fix exists. If you are a teammate inside the company,
raise it with them first.

## CI

`.github/workflows/ci.yml` runs on push and pull request against `main`, on Ubuntu and macOS, on
Node 22 and 24. It:

- asserts Node is 22.18 or newer and fails with a clear message if not;
- installs nothing, because there is nothing to install;
- parses every `.ts` file with Node's own type stripper and the ES module parser, which catches
  syntax errors without executing anything;
- imports the library modules, which proves the module graph resolves;
- checks that no `.ts` file contains an em dash or en dash, the repo's house rule;
- builds a synthetic three-note vault in the workspace, points `VAULT_PATH` at it and
  `CELSUS_CONFIG` at a temporary config, runs `node cli.ts doctor --no-network`, then boots
  `node serve.ts --port 3099`, curls `/api/state`, and asserts HTTP 200 with `deckSize` and `notes`
  in the payload.

It uses `actions/checkout@v4` and `actions/setup-node@v4` and nothing else. It reads no secrets,
needs no `secrets.*`, uploads no artifacts, and makes no network request other than the two `actions`
resolutions themselves. The config it writes contains an obvious placeholder key that authenticates
nothing, and `--no-network` keeps the test offline.