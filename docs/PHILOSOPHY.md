---
layout: single
title: 'Design Philosophy'
sidebar:
  nav: 'docs'
toc: true
toc_label: 'Principles'
toc_icon: 'compass'
---

# StratoSort Stack Design Philosophy

## Why this document exists

The tactical docs in this folder (`DI_PATTERNS.md`, `ERROR_HANDLING_GUIDE.md`, `IPC_CONTRACTS.md`,
`DEPENDENCY_BOUNDARIES.md`, `CODE_QUALITY_STANDARDS.md`) describe _how_ we build things. This doc
describes _why_ — the strategic principles that those tactical patterns serve. It draws on John
Ousterhout's _A Philosophy of Software Design_, calibrated to this codebase's reality.

Use this doc:

- As reviewers, when a change feels off but you can't name the smell.
- As authors, before opening a PR larger than ~300 LOC.
- As a future contributor, to understand which conventions are load-bearing and which are cosmetic.

This doc is **prescriptive**, not aspirational. The codebase already follows most of these
principles; the goal here is to make the principles explicit so they don't erode.

---

## Core principle: complexity is the enemy

Complexity is anything about a system that makes it hard to understand or modify. It shows up as
three symptoms:

- **Change amplification.** A small conceptual change requires many code edits.
- **Cognitive load.** A reader needs to understand a lot before they can change anything.
- **Unknown unknowns.** It isn't obvious what code or what facts a change depends on.

Every other principle below exists to attack one of these three symptoms.

---

## Principle 1: prefer deep modules

A **deep module** has a simple interface that hides substantial complexity. A **shallow module**
exposes nearly as much surface area as it implements — it adds cognitive load without taking
anything away.

**Rule of thumb for services in this codebase:** target **≥50 LOC of implementation per public
method**. The deep services we already have:

| Service              | LOC    | Public methods | LOC per method |
| -------------------- | ------ | -------------- | -------------- |
| `OramaVectorService` | ~5,400 | ~105           | ~51            |
| `LlamaService`       | ~4,300 | ~40            | ~107           |
| `SearchService`      | ~3,700 | ~43            | ~86            |
| `SmartFolderWatcher` | ~4,100 | ~35            | ~117           |

(LOC as of 2026-10; method counts are from the last hand count. Both drift as the code evolves —
treat them as illustrative, not exact.)

These are textbook deep modules: small public API, large hidden implementation (state machines,
retries, caching, fallback paths). **Do not split them** to chase a LOC target — the splits would be
the very pass-through layers we're trying to avoid.

Conversely, if a new service exposes 20 methods over 600 LOC, that's ~30 LOC/method and a yellow
flag. Ask: is the interface too wide? Could most of those methods be private?

**Caveat: count `async` methods.** A naive regex that matches `^  methodName(` will miss
`async methodName(` and produce misleadingly low ratios. An earlier shallow-service review flagged
three services as "shallow" using such a regex; once async methods were counted, all three were
within the deep-module band (43–71 LOC/method). When in doubt, count by hand or use an AST.

**Caveat: orchestrators get a pass.** A coordinator class whose public methods each front a
substantial sub-module legitimately has many small public methods. `AnalysisHistoryServiceCore` (35
LOC/method) is below the ≥50 threshold but each method orchestrates ≥2 cohesive submodules — it
earns the depth at the subsystem level, not the per-method level.

---

## Principle 2: information hiding before abstraction

A method's signature should reveal as little about its implementation as possible.

- **Private by default.** If a method isn't called from outside the class, it isn't part of the
  interface. Keep it private/non-exported.
- **Don't leak the storage format.** Methods that return persisted state should return a shape the
  caller wants, not the shape the database row uses.
- **Don't leak the wire format.** IPC handlers (see `IPC_CONTRACTS.md`) validate input with Zod and
  shape output for the renderer; renderer code should not know the main-process internals.
- **Single source of truth.** Config schemas live in `src/shared/`, channel names in
  `src/shared/constants.js`, error codes in `src/shared/errorCodes.js` (re-exported via
  `errorHandlingUtils.js`). Don't duplicate.

The strict main/renderer/shared boundary in `DEPENDENCY_BOUNDARIES.md` is a concrete expression of
this principle — the IPC layer is the only sanctioned leak point.

---

## Principle 3: pass-through layers are a red flag

A pass-through is a module that mostly forwards calls to another module without adding meaningful
abstraction. Two pass-throughs in series quadruple cognitive load while adding zero value.

**The pass-through test:** if you removed this module and inlined its callers into its callees,
would the system be meaningfully _worse_? If no, you have a pass-through.

**Legitimate thin layers we keep** (these are _not_ pass-throughs):

- The IPC boundary itself. It validates, enforces sender identity, rate-limits, and shapes errors.
  That work is real.
- `atomicFileOperations.js`. It looks thin but encodes atomicity + journal recovery.
- `ServiceContainer`. It's a registry, not a forwarder.

**Anti-patterns to avoid:**

- An IPC handler whose body is 200 lines of boilerplate around a single service call. Use the
  `createHandler` / `registerHandlers` helpers in `src/main/ipc/ipcWrappers.js`.
- A "Manager" class whose methods are 1:1 with another class's methods, just renamed.
- A React component that wraps another component with no added props, behavior, or styling.
- A Redux thunk that's just `dispatch(action(payload))` with no async work or branching.

---

## Principle 4: prefer general-purpose code

Over-specialization causes complexity. A function tailored to exactly one caller will be wrong for
the second caller, and rewriting it during integration costs more than designing it generally up
front.

**The two-caller question.** Before extracting a utility, ask: "Will this realistically have two
callers within the next month?" If no, inline it. If yes, design the interface around both callers
from the start.

**The "no specific caller in the API" test.** A general-purpose method's name and signature should
make sense without knowing which caller it was extracted for. A method named
`computeBatchSizeForOrganizeFlow()` is over-specialized; `computeBatchSize(itemCount, memoryBudget)`
is general.

Our heavy-hitter utilities (`ParallelEmbeddingService`, `WhisperService`, `atomicFileOperations`)
earn their generality — each has many callers and a name that describes capability, not workflow.

---

## Principle 5: design it twice

For any non-trivial change, the first design is rarely the best one. Spending 15 minutes on a second
alternative — even a brief sketch — almost always exposes assumptions baked into the first.

**The rule:** for any PR larger than ~300 LOC, the description includes a short "Alternatives
considered" section (3–5 lines per alternative). It can be terse. The point is to prove the chosen
design was a choice, not a default.

This applies especially to:

- New services or sub-services (alternatives: extend an existing service? add a method?)
- New IPC channels (alternatives: extend an existing channel's payload?)
- New Redux slices (alternatives: add to an existing slice?)
- Anything that crosses the main/renderer boundary

---

## Principle 6: comments explain _why_, not _what_

Well-named identifiers describe what the code does. Comments earn their keep only when they explain
something the code can't:

- A hidden constraint ("this must run before X because Y").
- A subtle invariant ("never null after initialization").
- A workaround for a specific bug or platform quirk, with a reference.
- Surprising behavior a reader would otherwise rediscover the hard way.

**Don't write:**

- Restatements of the code (`// increment i`).
- References to the current PR or ticket (those belong in the PR description; they rot).
- Multi-paragraph docstrings on methods whose names are already clear.

See `CODE_QUALITY_STANDARDS.md` for naming conventions that reduce the need for comments in the
first place.

---

## Principle 7: errors are designed, not added

Every error path is part of the interface. An error type that escapes a module's boundary becomes
the caller's problem.

This codebase enforces this via:

- Custom error types in `src/main/errors/` with a centralized classifier.
- Resilience policies (LlamaResilience, GPU→CPU fallback, DegradationManager) in
  `ERROR_HANDLING_GUIDE.md`.
- Lint rules: `promise/catch-or-return` and `promise/always-return` on `src/renderer/**/*`.

**Don't catch what you can't handle.** A bare `try/catch` that logs and swallows is rarely better
than letting the error propagate to a place that knows what to do. When you do catch, classify
(recoverable / user-facing / fatal) and route accordingly.

---

## Complexity budget heuristics

Numeric triggers for a "should we split this?" review comment. Hitting one isn't an automatic split;
it's an automatic _conversation_.

| Trigger                                             | Action                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Single file > 1,500 LOC **and** > 20 public methods | Discuss split                                                                               |
| React component > 800 LOC                           | Discuss extraction (sub-components, hooks)                                                  |
| IPC handler file > 1,500 LOC                        | Discuss helper extraction (the `createHandler` / `registerHandlers` pattern)                |
| New utility with exactly one caller                 | Inline or justify in the PR                                                                 |
| PR diff > 300 LOC of non-mechanical change          | Include "Alternatives considered"                                                           |
| Method body > 60 lines                              | Consider extracting helpers (not always — sometimes a state machine is genuinely one block) |

These are _guides_, not gates. CI does not enforce them. Reviewers do.

---

## Red flags to call out in review

When you see one of these, the right comment is "this looks like a [name]; can we restructure?"

- **Pass-through layer.** (See Principle 3.)
- **Shotgun parameters.** A method takes a giant config object whose fields are all optional and
  mutually-dependent. Often a sign two methods are pretending to be one.
- **Temporal coupling.** Calls must happen in a specific order, but nothing in the API signals that.
  Either enforce the order (state machine) or document it loudly.
- **Information leakage between modules.** Module A only works if it knows that Module B stores X as
  JSON. Modules should not need to know each other's internals.
- **God object.** A class that owns too many unrelated responsibilities. Usually grew organically;
  usually wants to be 3–4 classes.
- **Vague names.** `processData`, `handleStuff`, `Util`. The vagueness is a symptom of an unclear
  responsibility.
- **Comments explaining what.** Means the code isn't clear enough on its own.

---

## What is _not_ in scope for this doc

These belong to other docs; this one points at them rather than duplicating:

- Naming conventions, prefix rules, async patterns → `CODE_QUALITY_STANDARDS.md`
- IPC contract registration and Zod schemas → `IPC_CONTRACTS.md`
- Dependency injection / ServiceContainer lifetimes → `DI_PATTERNS.md`
- Cross-process boundaries and forbidden imports → `DEPENDENCY_BOUNDARIES.md`
- Error utilities and resilience policies → `ERROR_HANDLING_GUIDE.md`
- Atomic write protocol → comments in `src/shared/atomicFileOperations.js`

---

## Hard constraints (these survive every refactor)

The principles above are guidance. The following are non-negotiable: any change that violates one is
reverted regardless of how well it scores on the principles.

- **Electron is pinned at 41.x — and the pin is stale.** The original ABI/prebuild blockers are
  resolved upstream, and 41.x is now behind upstream security support, so a major bump is a pending
  security item. Do not bump it casually: follow the verification recipe in `.github/dependabot.yml`
  (the canonical rationale) in a separate worktree first.
- **Sandbox stays on; CSP has no `unsafe-eval`.** Sandbox is set in `src/main/core/createWindow.js`;
  the CSP is built in `src/main/core/securityHeaders.js`.
- **Every IPC handler goes through `ipcRegistry`.** No direct `ipcMain.handle`. The registry wraps
  handlers with `ipcSenderValidator` (defense in depth).
- **All input-accepting IPC channels have Zod schemas.** Only the `SCHEMA_OPTIONAL_CHANNELS`
  allowlist (zero-arg `WINDOW.*` chrome) is exempt; do not grow it.
- **Persisted state changes require a migration.** Bump `CURRENT_STATE_VERSION` in
  `src/renderer/store/migrations.js` and ship a tested migration. Old fixtures must still load.
- **Settings and state writes go through `atomicFileOperations.js`.** No direct `fs.writeFile`
  shortcuts on persisted state.
- **Coverage thresholds are a ratchet** (global: branches 52 / functions 62 / lines 63 / statements
  62, plus tighter per-directory floors) in `test/jest.config.js`. Don't lower them to make CI
  green; write tests instead.
- **`STRATOSORT_*` env vars must be documented** (`npm run verify:env-docs` gates CI).
- **License posture is PolyForm Noncommercial 1.0.0** (commercial licenses sold separately) —
  third-party obligations (LGPL FFmpeg attribution, etc.) are enforced by
  `compliance:commercial:verify`.

---

## Silent catches: convention

Empty `catch {}` blocks and `.catch(() => {})` / `.catch(() => null)` discard the rejection without
a trace. Sometimes that's correct (mutex-chain guards, fire-and-forget telemetry, defensive
finally-body guards) and sometimes it's a forgotten error path that costs ops a debugging session
when something goes wrong.

To make the intent legible at review time, every silent-catch site in `src/main/**` and
`src/shared/**` must satisfy **one** of these:

1. **Migrate to `swallow()`** from `src/shared/promiseUtils.js`:

   ```js
   const { swallow } = require('../shared/promiseUtils');
   await swallow(fs.unlink(tempPath), logger, 'cleanup:atomic-temp');
   // ↑ debug-logs rejections with the context tag; always resolves to undefined.
   ```

   Pass `'warn'` as the fourth argument for sites where a failure deserves production visibility.

2. **Add a `// why-silent:` comment** above the catch explaining the reason silence is correct:

   ```js
   this._writeChain = next.catch(() => {
     // why-silent: catch breaks chain poisoning; the original error already
     // surfaced to the caller via `return next` above.
   });
   ```

   Reviewers can `git grep "why-silent:"` to audit every documented silent site.

ESLint enforces this with `no-empty: ['warn', { allowEmptyCatch: false }]` — new empty catches are
flagged in the IDE and PR review. Use `// eslint-disable-next-line no-empty -- why-silent: <reason>`
when the empty body is the deliberate intent and `swallow()` is the wrong fit.

The `.catch(() => null)` and `.catch(() => [])` patterns are _not_ flagged by ESLint (they're not
"empty" — they return a fallback) but the convention still applies: prefer `swallow()` when the
caller will treat the rejection differently from the success-with-empty-result path.

---

## Verification

Most principles are reviewer-enforced. The hard constraints above are CI-enforced. Run:

```bash
npm run ci            # the canonical gate
npm run local:gate    # ci + verify:native-modules (pre-push)
```

If a PR proposes to change anything in **Hard constraints**, the PR description must say so
explicitly and be reviewed by someone other than the author.
