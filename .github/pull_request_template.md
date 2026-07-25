## What does this change?

<!-- One or two sentences. Link the issue it closes, if there is one. -->

Closes #

## How do you know it works?

<!--
The best answer is a failing test that now passes. Name it.
If the change is visual, attach a before/after screenshot.
-->

## Checklist

- [ ] `pnpm verify` passes (typecheck, lint, tests, build)
- [ ] New or changed behaviour has tests
- [ ] If this adds a heuristic, there is a test for what it **refuses** to match, not only what it matches
- [ ] Comments explain **why**, not what
- [ ] `src/core` still imports no React, Next.js, or Node built-ins
- [ ] Analysis output is still deterministic (no `Math.random()`, no `Date.now()` in analyzers)
- [ ] Interactive elements are keyboard operable, and colour is not the only signal

## Anything reviewers should know?

<!-- Trade-offs you made, alternatives you rejected, things you are unsure about. -->
