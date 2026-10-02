# Backlog

Ordered roughly by how much it hurts. Every item here is something the app should do and does not.

## 1. Nothing streams

**The problem.** `/api/ask` and `/api/narrate` are one blocking JSON blob. The model is called, nothing
comes back for 20 to 70 seconds, and the only thing on screen is this sentence, repeated verbatim in
three places in the UI:

> Thinking with space-bunny-alpha, about Sonali. Reasoning models take 20 to 70 seconds.

No progress, no elapsed time, no partial text, no indication the process is alive. From the user's
side this is indistinguishable from a hang, and the copy admits it by quoting a 50 second range and
then doing nothing for 50 seconds.

**What it should be.** A real stream, in stages, so the wait is legible:

- **Elapsed time that ticks.** The first second shows nothing, which is when people assume it broke.
- **Stage chips.** Not decoration: the actual phases, so the wait explains itself. `reading notes`,
  `following links`, `cross-checking`, `writing`, each lighting as it starts. If the stages are
  invented rather than real, they are theatre and should not be built.
- **Partial text as it arrives**, so the answer visibly grows instead of appearing whole.
- **Streaming chips**, the thing to design well. They are the primary signal that work is happening.
  They need to be small, quiet, and never reflow the layout underneath the user.
- **A marquee** for the long waits, so a 60 second reasoning model does not look frozen.
- **Honest failure.** If it exceeds some sane ceiling, say so and offer a retry rather than spinning
  forever. Right now there is no ceiling at all.

**Constraint that must not break.** The learner depends on the model returning *valid JSON* that
`extractJson` parses. Streaming raw model output into the page means the parse can fail on a partial
buffer, mid-stream, in front of the user.

**Decided, 2026-10-02:** ship the stage chips and the ticking clock first and **leave the answer text
whole**. They are driven by the server, not by the model's prose, so they carry no parse risk at all
and the wait becomes legible immediately. Streaming the answer body is a separate later step and needs
a delimiter or a partial-JSON-safe approach, plus defined behaviour for a stream that ends on invalid
JSON. It does not ride along with the chips.

**Ordered, so this is buildable rather than a wish:**

1. Server sends stage events over a stream, or at minimum reports elapsed time.
2. Stage chips and a live clock, no answer text streamed.
3. A sane ceiling with an honest failure and a retry, which does not exist today.
4. Marquee and the mascot's state tracking, once the wait is honest.
5. OpenUI-standard renderer replacing `renderView`.
6. Streaming the answer body, last, behind the partial-JSON work.

## 2. The answer arrives as a wall of hand-built HTML

**The problem.** `renderView` turns a JSON view object into a bespoke dark-mode panel: a paragraph, a
four column metric grid, a two by two entity grid, a Next line, a debug footer. It looks the same every
time, the entity cards are boilerplate ("Linked person record with 1 link."), and the footer shows a
raw `SPACE-BUNNY-ALPHA · 20329 MS` where a human-facing label belongs.

**What it should be.** OpenUI, the open standard for generative UI, where the model streams live
components rather than a JSON blob the client has to know how to draw. The model picks the component
and the client renders it, so a future answer can use a shape nobody hand-coded.

**Decided, 2026-10-02:** adopt the OpenUI **component standard**, hand-write a small renderer in the
existing inline script, and keep zero dependencies and no build step. The framework is not being
adopted. Recorded here so the next reader knows this was a choice rather than an oversight.

**The cost of the framework, for the record.** OpenUI is a real project,
https://github.com/thesysdev/openui, and the framework version is not free to adopt here:

- It is a **React** framework. This UI is a **single dependency-free HTML file** with an inline
  script, on purpose, so `celsus serve` works with nothing installed. Adopting it means a build step,
  a `node_modules`, and giving up the property the whole repo is built on.
- The alternative is to **adopt the standard, not the framework**: have the model emit OpenUI-shaped
  component descriptors, and write a small renderer in the existing inline script. That keeps zero
  dependencies and the no-build property, and it is the version worth doing. It is also real work, and
  it is a protocol, not a skin.

**Rejected, and why, so nobody re-litigates it:**

1. Adopt OpenUI the framework. Rejected: it means React, a `node_modules` and a build step, and the
   whole repo is built on `celsus serve` working with nothing installed.
2. Keep the bespoke panel, fix only the cosmetics. Rejected: it is a dead end, since the next answer
   shape the model invents still cannot be drawn.
3. **Adopt the standard, hand-write the renderer.** Chosen: the extensibility without the dependency.

## 3. Easter eggs

Fun, low risk, and they belong in the mascot. Ideas, none built:

- The mascot's expression tracks real state: thinking, confused, pleased, smug. It has a state
  machine already (`petState`), so this is nearly free.
- Rare cards get a joke. A `dup|rename` card about a folder that is nearly named right.
- Konami code, or clicking the mascot five times, for a graph that briefly becomes a word cloud.
- A "you have answered 100 cards" moment that is quietly delightful rather than a modal.
- Long-wait encouragement that escalates, so a 60 second wait ends with something better than a
  spinner.

**Rule for all of it.** No egg may block, lie, or slow a real answer. An egg that delays the answer to
be funny is a bug with a punchline.

## 4. Smaller things noticed in passing

- The response panel shows `SPACE-BUNNY-ALPHA · 20329 MS`. Raw internals where a human label belongs.
  Cache hits, latency bands, "written by another model" are more useful than a stopwatch.
- The linked-entity cards are boilerplate: "Linked person record with 1 link." They could carry the
  actual one line that connects them, which is the part worth knowing.
- The summary opens by describing the shape of the data rather than the thing. "Sonali is recorded as
  a person, but the dossier provides no biographical details" tells you about the database. It should
  say what Sonali *is*, and admit the gap once rather than leading with it.
- No keyboard route from the search bar to Settings, and no way to reach the folder chooser without
  the mouse.

## How this list stays honest

An item leaves this list when it is built and verified, not when it is planned. If an item turns out
to be wrong, it gets deleted here rather than quietly reworded. The same rule that produced the
"a test that could not fail" commit: a claim that cannot be checked is not a claim.
