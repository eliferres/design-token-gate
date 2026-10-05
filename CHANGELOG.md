# Changelog

## [1.1.0] - 2026-10-02

### Added

- Installable as a command: `npm install --global github:eliferres/design-token-gate`
  (or `npx github:eliferres/design-token-gate`) puts `design-token-gate` on your
  PATH, and `design-token-gate --version` prints the version.

- Spacing, border width, duration and breakpoint ladders, read from the
  tokens file by name like the font-size and radius ladders. Each one is
  checked only when the tokens file declares it, so an existing setup keeps
  passing until you add the tokens. Each run names the optional ladders its
  tokens file mentions, on or off, so a scale written in `rem` is reported
  as off instead of passing in silence.
- A `/* token-vouch: <reason> */` comment accepts the hand-typed values on its
  own line. Each one is listed in the report with its reason and counted in
  the closing line, and none of them enter the baseline.
- `--allow-file <glob>`, repeatable, skips whole files such as a token
  specimen page or a vendored embed. The report counts the skipped files and
  names any pattern that matched nothing; patterns that skip every file stop
  the run with exit 2.

### Changed

- Exit 2 now means the gate could not run: a missing tokens file or scope
  directory, an unknown flag, a tokens file with no ladder in it, or a missing
  baseline without `--freeze`. Exit 1 still means the gate ran and found a
  violation, exit 0 still means clean, so a script can tell drift from a typo.

### Fixed

- A font-size, border-radius or box-shadow declaration at the start of a line
  was reported one line too early.
- The demo picture no longer cuts its long lines off at the right edge: rows
  wider than the box ran past it mid-word with no ellipsis. Only the drawing
  changed; the recorded session is untouched.
- `--scope` pointed at a project root no longer reports violations in vendored
  or generated code: `node_modules`, `.git`, `dist`, `build`, `coverage` and
  `.next` are never scanned.

## [1.0.0](https://github.com/eliferres/design-token-gate/releases/tag/v1.0.0) - 2026-09-03

First public release.
