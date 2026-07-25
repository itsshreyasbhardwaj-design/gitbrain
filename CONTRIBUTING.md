# Contributing to GitBrain

Thanks for being here. This document is short on ceremony and specific about the things that
actually matter in this codebase.

## Getting set up

```bash
git clone https://github.com/itsshreyasbhardwaj-design/gitbrain.git
cd gitbrain
pnpm install
pnpm dev
```

No `.env` file is required. Everything works with zero configuration — if you find something
that does not, that is a bug worth reporting.

Before opening a pull request:

```bash
pnpm verify   # typecheck + lint + test + build
```

## Good first contributions

Two areas are deliberately table-driven so that adding to them is low-risk and high-value:

**Add a language to the import parser** — `src/core/graph/imports.ts` and
`src/core/graph/resolve.ts`. Each language is a small scanner plus resolution rules, and
`imports.test.ts` has 23 tests to copy the shape from. C#, Swift, Elixir and Scala are all
unclaimed.

**Add a rule to the stack detector** — `src/core/detect/stack.ts` is a rule table. A new
framework, CI provider or database is usually a few lines plus a test. Read the confidence ladder
at the top of the file first.

Also useful: a new secret-detection rule (`src/core/security/secrets.ts`), or a new health signal
(`src/core/health/index.ts`).

## The rules that matter

### 1. `src/core` stays framework-free

Everything under `src/core` is pure TypeScript. It cannot import React, Next.js, or Node
built-ins — ESLint enforces this, and `src/core/ingest` is the single exception, because it is
the only thing allowed to touch the network.

This is not architectural purity for its own sake. It is what lets the entire analysis engine be
unit-tested without a DOM, and ported to a CLI or a worker without a rewrite.

### 2. Never state something you did not measure

This is the project's core promise. If the analyzers did not find an authentication flow, the
authentication document says so — it does not guess, and it does not fill the gap with plausible
prose. If a detection is uncertain, it carries a lower confidence and the UI treats it
accordingly.

Concretely:

- Every `Detection` carries the `evidence` and `files` that produced it.
- Every knowledge document cites real paths that exist in the snapshot.
- Anything truncated, skipped or capped is **reported**, never silently dropped.

A pull request that makes output _sound_ better by making it less grounded will not be merged.

### 3. Heuristics need a test for what they refuse to do

Any detector will find true positives. The hard part is not firing on the other 99%. So a new
rule needs tests for both directions:

```ts
it('detects a committed AWS key', ...)
it('ignores the same shape inside .env.example', ...)
it('ignores an obvious placeholder', ...)
```

The secret scanner, the marker scanner and the complexity counter all run over a shared lexer
(`maskSource` in `src/core/metrics/complexity.ts`) that blanks comment and string interiors while
preserving column positions. Use it rather than adding another regex pass — it is why `eval(`
inside a string is not a finding.

### 4. Analysis must stay deterministic

The same snapshot always produces the same report. That is what makes the tests meaningful and
the results trustworthy. No `Math.random()`, no `Date.now()` inside the analyzers, no ordering
that depends on object key iteration.

### 5. Accessibility is part of the work

Every interactive element is keyboard operable with a visible focus ring. Colour never carries
meaning on its own — every tone is paired with text or an icon. Charts ship a text equivalent,
because a polygon is not accessible.

## Style

Prettier and ESLint decide formatting; do not argue with them, run `pnpm lint:fix` and
`pnpm format`.

Beyond that, one request: **comments should explain why, not what.** The codebase is full of
non-obvious tuning decisions — why BM25's `b` is 0.45 instead of 0.75, why lockfiles keep their
tree entry but lose their contents, why a devDependency is weak evidence for a framework. Those
comments are the most valuable thing in the repository. Match that standard.

## Commits and pull requests

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(detect): add Elixir framework detection
fix(search): handle identifiers that collide with Object.prototype
docs(readme): clarify the zero-configuration promise
test(graph): cover deeply nested Python relative imports
```

In the pull request, say what you changed and **how you know it works**. A failing test that now
passes is the best possible answer.

## Reporting bugs

The most useful bug report names a **public repository that GitBrain gets wrong**, and says what
the right answer is. That is directly reproducible and usually becomes a test case.

Security issues: please follow [SECURITY.md](./SECURITY.md) rather than opening a public issue.

## Code of Conduct

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).
