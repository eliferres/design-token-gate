# Changelog

## Unreleased

### Added

- Installable as a command: `npm install --global github:eliferres/design-token-gate`
  (or `npx github:eliferres/design-token-gate`) puts `design-token-gate` on your
  PATH, and `design-token-gate --version` prints the version.

### Fixed

- The demo picture no longer cuts its long lines off at the right edge: rows
  wider than the box ran past it mid-word with no ellipsis. Only the drawing
  changed; the recorded session is untouched.
- `--scope` pointed at a project root no longer reports violations in vendored
  or generated code: `node_modules`, `.git`, `dist`, `build`, `coverage` and
  `.next` are never scanned.

## [1.0.0](https://github.com/eliferres/design-token-gate/releases/tag/v1.0.0) - 2026-09-03

First public release.
