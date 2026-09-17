# design-token-gate

Every shipped screen draws its colors, type sizes, corners, and shadows from one tokens file, or the build fails. design-token-gate reads the ladders from your tokens.css, scans the source for hand-typed values that should have been a token, and holds a frozen list of old debt that can only shrink. Node 18+, no dependencies.

![ci](https://github.com/eliferres/design-token-gate/actions/workflows/ci.yml/badge.svg)

<img src="demo/terminal.svg" width="660" alt="Terminal session showing design-token-gate refusing a source file with a raw hex, an off-ladder radius, and a raw shadow color, then passing the same file rewritten to use var().">

## Install

Install the command:

```bash
npm install --global github:eliferres/design-token-gate
```

Or run it without installing anything:

```bash
npx github:eliferres/design-token-gate --tokens src/tokens.css --scope src --baseline design-token-baseline.json
```

Either way the installed command is `design-token-gate`, and
`design-token-gate --version` prints the version. The tool is not published
to the npm registry; both forms install straight from the GitHub repo.

To run the demo below, clone the repo instead:

```bash
git clone https://github.com/eliferres/design-token-gate.git
cd design-token-gate
node design-token-gate.mjs --tokens demo/tokens.css --scope demo/src --baseline demo/baseline.json
node design-token-gate.mjs --tokens demo/tokens.css --scope demo/clean-src --baseline demo/baseline.json
```

Zero dependencies, Node 18+, no network needed for the demo. `demo/tokens.css`
holds six tokens: two colors, two font sizes, one radius, one shadow.
`demo/src/card.css` hardcodes three of those values by hand and gets one
radius wrong; `demo/clean-src/card.css` is the same rule written with
`var()`.

## Walkthrough

Run the gate against the hand-typed file:

```bash
node design-token-gate.mjs --tokens demo/tokens.css --scope demo/src --baseline demo/baseline.json
```

```text
design-token-gate: 3 violation(s) - demo/tokens.css owns the tokens and ladders:
  src/card.css:2 raw #1a1a2e -> use var(--color-ink)
  src/card.css:5 off-ladder border-radius 6px -> use var(--radius-card) (ladder: 8)
  src/card.css:4 raw shadow color -> use var(--shadow-card)

Grandfathered debt is frozen in baseline.json - that list only shrinks.
```

Exit code 1. The font-size in that same file is a hand-typed `14px`, but it
is not reported: it happens to sit exactly on the font-size ladder, so the
gate has nothing to correct even though the honest fix is still `var()`.
Rule 2 only refuses a value once it falls off the ladder.

Now run it against the file written with tokens:

```bash
node design-token-gate.mjs --tokens demo/tokens.css --scope demo/clean-src --baseline demo/baseline.json
```

```text
design-token-gate: clean - every token value flows from demo/tokens.css (0 grandfathered violation(s) still owed).
```

Exit code 0.

## Wiring it into CI

```json
{
  "scripts": {
    "design-tokens": "node design-token-gate.mjs --tokens src/tokens.css --scope src --baseline design-token-baseline.json"
  }
}
```

```yaml
- name: Design tokens
  run: npm run design-tokens
```

Any exit code other than 0 fails the step, so a hand-typed value in a pull
request blocks the merge the same way a failing test would. The two
non-zero codes are worth telling apart in a script: 1 means the gate ran
and found drift, 2 means the gate could not run at all (a missing tokens
file or scope directory, an unknown flag, a missing baseline). A step that
inverts the command and accepts any non-zero code reads a typo in a path
as a caught violation; check for exit 1 on purpose instead.

## How the baseline works

A codebase that already hardcodes hundreds of values cannot switch this
gate on cold: the first run would fail everywhere, and a gate that fails
everywhere gets deleted, not fixed. Point `--baseline` at a JSON file and
run with `--freeze` once, before the gate is wired into CI:

```bash
node design-token-gate.mjs --tokens src/tokens.css --scope src --baseline design-token-baseline.json --freeze
```

That writes a file keyed by source file, then by the offending value, then
by how many times it occurs. Both rules feed the same baseline: a rule 2
ladder miss is keyed by its value (`"font-size:13px"`), and a rule 1 raw
hex is keyed by the hex string itself (`"#1a1a2e"`) - a codebase that
hardcodes a token's color a hundred times is exactly as much pre-existing
debt as one that hand-types a hundred off-ladder font sizes, and only
freezing one of the two rules is how a legacy tree "passes" the gate right
up until CI is wired and it fails on day one. Line numbers are never part
of either key, so moving a declaration to another line does not fail the
build, but adding a new one does. From then on the gate passes anything at
or under the frozen count and refuses anything above it. Fix a violation
and the count naturally drops; run `--freeze` again to lower the ceiling
to match. Raising a count needs a deliberate `--freeze --allow-increase`,
which is the shape of change a reviewer should ask about in a diff.

## Limitations

- Static analysis only, over CSS files and inline `style={{ }}` objects in
  JS/TS/JSX/TSX. Nothing is rendered, no computed styles, no CSS-in-JS
  template literals, no Sass or Less variables.
- The walker never descends into `node_modules`, `.git`, `dist`, `build`,
  `coverage`, or `.next`, so pointing `--scope` at a project root grades
  your source and not your dependencies or your build output. That list is
  fixed and there is no flag to change it.
- Which custom properties feed which ladder is decided by the property
  name in your tokens file: `text` or `font` for the font-size ladder,
  `radius` or `corner` for the radius ladder, `shadow` or `elev` for shadow
  tokens. A tokens file that names things differently needs no code
  change, just token names the gate can read.
- The radius and font-size rules flag values that fall *off* the ladder,
  not every hand-typed value that happens to match one on it. A `14px`
  that equals an existing token is still not a `var()`, and this gate will
  not tell you that.
- The hex rule matches six-digit hex colors only, and only the exact value
  of an existing token. `rgb()`, `hsl()`, three-digit hex, and colors that
  are close but not identical to a token all pass silently.

## Why

This came out of an internal app where a growing token system kept
getting bypassed by hand-typed values that slipped past code review: a
hex that matched a color token, a font size one pixel off the type scale,
a shadow copied from a previous component instead of the shared elevation
token. A hex-only lint caught the first kind and missed the other two for
months, until a design review found all three on one shipped screen at
once. This is the generalized, standalone version of the gate that came
out of fixing that: no company names, no fixed directory layout, just a
tokens file and a directory to scan.

MIT licensed. See LICENSE.
