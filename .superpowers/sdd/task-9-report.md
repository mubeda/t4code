# Task 9 — packaged composer acceptance

## Outcome

Task 9 is complete on the definitive integrated HEAD
`7b2a41c05df016ba7885fc1de8d796707e9da2f5`.

The packaged acceptance work:

- exercises Codex, Claude, Cursor, OpenCode, and Grok in separate,
  provider-locked panels;
- verifies every visible model row through its raw provider-instance ID and
  model slug, with no provider rail and no foreign-provider rows;
- verifies `:`, `/`, `$`, and `@` trigger groups and stale-menu closure;
- sends and records seven exact native provider payloads, including a selected
  file reference and a selected Claude skill;
- persists capability-valid Codex and OpenCode drafts, performs a real WebDriver
  session restart, reselects the exact host thread, and verifies restored file,
  agent, and skill chips in their original panels;
- isolates the composer's payload sequence from provider-log entries written by
  earlier default-suite specs.

## Task 9 commits

- `2afec28546` — `fix: lock provider panels and harden packaged acceptance`
- `ec1c491bc5` — `test: strengthen packaged composer acceptance`
- `d2e87c71c9` — `test: isolate packaged composer payload evidence`
- `ce8d0d3f0d` — `test: activate packaged composer host panel`
- `942b8ef43a` — `test: select persisted composer tokens`
- `067a1b2f20` — `test: verify persisted chip source separately`

The final integrated source also contains the provider-aware editor corrections
through `7b2a41c05d`.

## TDD and packaged-debug evidence

The provider-lock regression was first made red by requiring
`lockToActiveInstance === true` for a new chat whose `lockedProvider` was
initially `null`:

```text
vp test apps/web/src/components/chat/ChatComposer.test.tsx
1 failed, 99 passed
expected false to be true
```

After the minimal production correction:

```text
vp test apps/web/src/components/chat/ChatComposer.test.tsx
1 file passed, 100 tests passed
```

Static packaged-harness contracts were also changed before implementation.
They failed for the missing semantic model-row assertions, session-restart
payload oracle, shared-log baseline, host-panel activation, and selected-token
construction, then passed after each focused correction.

Provisional packaged runs exposed and corrected four invalid test assumptions:

1. A rendered file chip's presentation text is not the native `@README.md`
   source token; the exact provider log is the send oracle.
2. The Codex host surface is the tab named `Main`, not a provider-created tab
   named `Codex`.
3. Persisted semantic tokens must be selected from their capability menus, not
   injected as already-completed plain text.
4. A semantic chip's rendered text is not its native draft source; exact
   persisted storage and exact chip type are verified separately.

The final focused harness suite passed 22/22 tests, scoped formatting/lint
passed, and the desktop E2E TypeScript project typechecked.

## Definitive verification

All results below were produced from exact HEAD `7b2a41c05d`:

- `vp check`: passed; 1,608 files formatted and 1,224 files lint-clean.
- `vp run typecheck`: passed all 11 tasks. Existing Effect finite-number
  suggestions remain informational.
- `vp test`: passed 517 files and 7,023 tests.
- `vp run test:ui:desktop:build`: passed and emitted a fresh arm64 DMG.
- Scoped packaged composer spec: passed 1/1 in 18.2 seconds.
- Full default packaged suite: passed 5/5 in 24 seconds; its composer spec
  passed in 16.2 seconds.
- `codesign --verify --deep --strict --verbose=2`: valid on disk and satisfies
  its designated requirement.
- `git diff --check`: passed.
- Final working tree contains only the three intentional Task 7/8/9 report
  modifications.

## Exact scoped provider payloads

The scoped log contains exactly seven entries and zero colon-prefixed payloads:

```text
codex       $refactor
codex       @README.md
claudeAgent /compact
claudeAgent /docs
cursor      /review
opencode    @reviewer
grok        /skills
```

## Definitive packaged artifacts

- DMG:
  `/Users/admin/.codex/worktrees/cd36/t4code/target/release/bundle/dmg/T4Code (Alpha)_0.2.7_aarch64.dmg`
- DMG SHA-256:
  `28032e91e957dfaee00989c7f58bc7aa74a1ce6bb0b18136d728b1332a54536d`
- Final mount:
  `/tmp/t4code-task9-final.objUDW`
- Final mounted app:
  `/tmp/t4code-task9-final.objUDW/T4Code (Alpha).app`
- Canonical executable:
  `/private/tmp/t4code-task9-final.objUDW/T4Code (Alpha).app/Contents/MacOS/t4code-desktop`
- Scoped composer artifacts:
  `/var/folders/0g/1h6wmh5d5611nc09pwff_1qm0000gn/T/t4code-desktop-ui-artifacts-AXrJIU`
- Full default-suite artifacts:
  `/var/folders/0g/1h6wmh5d5611nc09pwff_1qm0000gn/T/t4code-desktop-ui-artifacts-FOZMBY`
- Exact scoped provider log:
  `/var/folders/0g/1h6wmh5d5611nc09pwff_1qm0000gn/T/t4code-desktop-ui-artifacts-AXrJIU/provider-input.jsonl`
- Locked-picker screenshot:
  `/var/folders/0g/1h6wmh5d5611nc09pwff_1qm0000gn/T/t4code-desktop-ui-artifacts-AXrJIU/composer-provider-locked-model-picker.png`
- Restored OpenCode chips:
  `/var/folders/0g/1h6wmh5d5611nc09pwff_1qm0000gn/T/t4code-desktop-ui-artifacts-AXrJIU/composer-restored-chips.png`
- Restored Codex skill chip:
  `/var/folders/0g/1h6wmh5d5611nc09pwff_1qm0000gn/T/t4code-desktop-ui-artifacts-AXrJIU/composer-restored-codex-skill-chip.png`

No GUI app was manually launched or terminated. The final DMG mount is left
available for the main agent's isolated Computer Use pass.
