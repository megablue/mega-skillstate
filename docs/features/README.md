# opencode-g-skill-state — features map

Read this before touching code: find the area, then open only the one or two
feature docs it points at.

Read order: `HANDOFF.md` (current state) → this index → **the page for your
area** → the code. `docs/SPEC.md` is user-visible behavior; `AGENTS.md` is
process and hard rules; the docs below are the map, the mechanism and the
traps.

**Keep this map true in the same commit as the change.** Before staging a
commit, update the feature doc(s) for whatever you changed, and add a row here
if the doc is new. User-visible behavior also updates `docs/SPEC.md` in the
same commit; a docs-only follow-up commit is the one that gets skipped. Pure
refactors with no behavior, mechanism, config or test change need no edit.

| Feature | Doc | Read when |
| --- | --- | --- |
| Context collapse | [context-collapse.md](context-collapse.md) | outbound payload too big; Σ missing from a request; a tool call and its result were split; idempotence; the `context` hook |
| Σ store & schema | [skill-state.md](skill-state.md) | Σ fields; a null that should delete; an unknown key that should be dropped; arrays replace vs merge; seeding from tools; state persistence / restart; render |
| Compaction | [compaction.md](compaction.md) | the host asks for a compaction; a summary that lost the plan; Σ that never reaches a compaction; a restart before compaction |
| skill_state tool & /skillstate | [skill-state-controls.md](skill-state-controls.md) | the model updating Σ; `state_patch`; the ack; a tool registered but never called; `/skillstate`; forcing a collapse; the stale reminder; **installing or uninstalling the plugin** |

<!-- One row per feature page (added as pages land). Keep "Read when" a trigger
someone would search for — the file, the symbol, the symptom — not a
restatement of the title. -->

The index is the entry point, not a glob: pages may live in subdirectories as
well as at the top level, so `docs/features/*.md` alone misses them. Follow the
row's link.

## Doc template

Every feature doc uses these headings, in this order, so a section can be
found by grep **and read on its own**: the headings are the retrieval unit, and
a reader is handed one section at a time rather than the whole page.

    # <Feature> — <one-line summary>
    Status: shipped (vX.Y) · Read when: <trigger>

    ## What it does
    3–6 bullets; link `docs/SPEC.md` for the user-visible detail.

    ## Map
    Files, types, functions and test names — the anti-hunting payload.
    Names, never line numbers (they rot).

    ## How & why
    The mechanism, the invariants and the traps: cause and effect, not a
    retelling of the bug that produced the rule.

    ## Config keys / UI
    Dense table: key, default, range or clamp, and the control that sets it.

    ## Tests that pin it
    Test names — run these first when touching the area.

    ## Related
    Links to the other feature docs.

Keep a doc 60–200 lines and split past ~250, and keep a section under about
two kilobytes: a section is what a later reader asks for by name, and one that
outgrew a single read has to be split with `###` before it can be handed over
whole. No sentence lives in two docs: `docs/SPEC.md` is behavior, a feature doc
is map/mechanism/traps, `AGENTS.md` is process.
