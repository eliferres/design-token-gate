# Contributing

Welcome things:

- Fixes to the regex-based parsing when real-world CSS or JSX reads wrong.
- New tests for a case the current suite does not cover, especially a
  planted defect in a fixture rather than an assertion on internals.
- Fixes to anything the README claims that turns out not to be true.
- Naming conventions for a ladder shape this gate does not yet recognize
  (say what your tokens look like and why the current name test misses them).

Ground rules: `design-token-gate.mjs` stays dependency-free, single-file,
and ESM. Every ladder value comes from the tokens file at runtime, never
gets retyped into the gate. Baseline keys stay file-and-value only, never
a line number, so moving a declaration never fails the build. Keep
`node --test tests/*.test.mjs` green. Taste arguments about where a value
belongs in a ladder go in your own tokens file, not in an issue here.
