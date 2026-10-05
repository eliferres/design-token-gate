/*
 * Hermetic tests for design-token-gate.mjs. Every case builds a throwaway
 * tree with its own tokens file, source file, and baseline, then runs the
 * gate against it with explicit --tokens/--scope/--baseline flags. Nothing
 * here reads or writes outside the temp directory it creates.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file, not from the working directory, so the suite runs
// the same wherever it is invoked from.
const GATE = fileURLToPath(new URL("../design-token-gate.mjs", import.meta.url));

// A miniature tokens file carrying the hex map, both ladders, and a shadow token.
const TOKENS = `:root {
  --color-ink: #1a1a2e;
  --text-caption: 10px;
  --text-sm: 12px;
  --text-base: 16px;
  --radius-panel: 16px;
  --radius-card: 12px;
  --radius-control: 8px;
  --shadow-card: 0 1px 2px rgba(16, 24, 40, 0.05);
  --shadow-pop: 0 4px 10px rgba(16, 24, 40, 0.06);
}
`;

function makeTree({ css = "", tsx = null, baseline = { counts: {} }, extra = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-token-gate-"));
  const write = (rel, body) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  write("tokens.css", TOKENS);
  write("src/probe.css", css);
  if (tsx !== null) write("src/Probe.tsx", tsx);
  if (baseline !== null) write("baseline.json", JSON.stringify(baseline, null, 2));
  for (const [rel, body] of Object.entries(extra)) write(rel, body);
  return root;
}

function runGate(root, ...flags) {
  const r = spawnSync(
    process.execPath,
    [GATE, "--tokens", path.join(root, "tokens.css"), "--scope", path.join(root, "src"), "--baseline", path.join(root, "baseline.json"), ...flags],
    { encoding: "utf8" }
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const PROBE_CSS = "src/probe.css";

test("a surface built entirely from tokens passes", () => {
  const root = makeTree({
    css: `.a { font-size: var(--text-sm); border-radius: var(--radius-card); box-shadow: var(--shadow-card); }\n`,
  });
  const { code } = runGate(root);
  assert.equal(code, 0);
});

test("hex that is a token is refused when hand-typed", () => {
  const root = makeTree({ css: `.a { color: #1a1a2e; }\n` });
  const { code, out } = runGate(root);
  assert.equal(code, 1);
  assert.match(out, /raw #1a1a2e -> use var\(--color-ink\)/);
});

test("a hex fallback inside var() is legal", () => {
  const root = makeTree({ css: `.a { color: var(--color-ink, #1a1a2e); }\n` });
  assert.equal(runGate(root).code, 0);
});

test("off-ladder font-size is refused and names the nearest ladder token", () => {
  const root = makeTree({ css: `.a { font-size: 13px; }\n` });
  const { code, out } = runGate(root);
  assert.equal(code, 1);
  assert.match(out, /raw font-size 13px/);
  assert.match(out, /--text-(sm|base)/);
});

test("an on-ladder font-size value passes", () => {
  const root = makeTree({ css: `.a { font-size: 12px; }\n` });
  assert.equal(runGate(root).code, 0);
});

test("off-ladder border-radius is refused; an on-ladder value is not", () => {
  const bad = runGate(makeTree({ css: `.a { border-radius: 10px; }\n` }));
  assert.equal(bad.code, 1);
  assert.match(bad.out, /off-ladder border-radius 10px/);

  const good = runGate(makeTree({ css: `.a { border-radius: 12px; }\n` }));
  assert.equal(good.code, 0, "12px is on the ladder - only OFF-ladder values are flagged");
});

test("raw box-shadow color is refused and points at a shadow token", () => {
  const root = makeTree({ css: `.a { box-shadow: 0 8px 24px rgba(23, 23, 23, 0.12); }\n` });
  const { code, out } = runGate(root);
  assert.equal(code, 1);
  assert.match(out, /raw shadow color/);
  assert.match(out, /--shadow-card/);
});

test("box-shadow: none and var() shadows pass", () => {
  const root = makeTree({ css: `.a { box-shadow: none; } .b { box-shadow: var(--shadow-pop); }\n` });
  assert.equal(runGate(root).code, 0);
});

test("commented-out violations do not trip the gate", () => {
  const root = makeTree({ css: `/* .a { font-size: 13px; border-radius: 10px; } */\n.b { color: red; }\n` });
  assert.equal(runGate(root).code, 0);
});

test("a token hex inside a /* */ comment is not flagged", () => {
  const root = makeTree({ css: `/* .a { color: #1a1a2e; } */\n.b { color: red; }\n` });
  assert.equal(runGate(root).code, 0);
});

test("a token hex inside a // line comment is not flagged", () => {
  const root = makeTree({
    css: "",
    tsx: `// const ink = "#1a1a2e";\nexport const A = () => <div />;\n`,
  });
  assert.equal(runGate(root).code, 0);
});

test("baseline suppresses a known violation at its frozen count", () => {
  const root = makeTree({
    css: `.a { font-size: 13px; }\n.b { font-size: 13px; }\n`,
    baseline: { counts: { [PROBE_CSS]: { "font-size:13px": 2 } } },
  });
  assert.equal(runGate(root).code, 0);
});

test("one more of a baselined value is refused without --allow-increase", () => {
  const root = makeTree({
    css: `.a { font-size: 13px; }\n.b { font-size: 13px; }\n.c { font-size: 13px; }\n`,
    baseline: { counts: { [PROBE_CSS]: { "font-size:13px": 2 } } },
  });
  const { code, out } = runGate(root);
  assert.equal(code, 1);
  assert.match(out, /3 present, 2 grandfathered/);
});

test("moving a declaration to another line does not change the baseline key", () => {
  const baseline = { counts: { [PROBE_CSS]: { "font-size:13px": 1 } } };
  const top = runGate(makeTree({ css: `.a { font-size: 13px; }\n\n\n`, baseline }));
  const bottom = runGate(makeTree({ css: `\n\n.a { font-size: 13px; }\n`, baseline }));
  assert.equal(top.code, 0);
  assert.equal(bottom.code, 0);
});

test("--freeze rewrites the baseline from the current tree", () => {
  const root = makeTree({
    css: `.a { font-size: 13px; }\n`,
    baseline: { counts: { [PROBE_CSS]: { "font-size:13px": 5 } } },
  });
  assert.equal(runGate(root, "--freeze").code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(root, "baseline.json"), "utf8"));
  assert.equal(written.counts[PROBE_CSS]["font-size:13px"], 1);
});

test("--freeze refuses to raise the ceiling without --allow-increase", () => {
  const root = makeTree({
    css: `.a { font-size: 13px; }\n.b { font-size: 13px; }\n`,
    baseline: { counts: { [PROBE_CSS]: { "font-size:13px": 1 } } },
  });
  const refused = runGate(root, "--freeze");
  assert.equal(refused.code, 1);
  assert.match(refused.out, /refusing to freeze/);

  const forced = runGate(root, "--freeze", "--allow-increase");
  assert.equal(forced.code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(root, "baseline.json"), "utf8"));
  assert.equal(written.counts[PROBE_CSS]["font-size:13px"], 2);
});

test("--freeze grandfathers rule 1's raw hex debt too, keyed by the hex string", () => {
  const root = makeTree({ css: `.a { color: #1a1a2e; }\n.b { color: #1a1a2e; }\n`, baseline: null });
  assert.equal(runGate(root, "--freeze").code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(root, "baseline.json"), "utf8"));
  assert.equal(written.counts[PROBE_CSS]["#1a1a2e"], 2);
});

test("a baselined hex is suppressed up to its frozen count", () => {
  const root = makeTree({
    css: `.a { color: #1a1a2e; }\n.b { color: #1a1a2e; }\n`,
    baseline: { counts: { [PROBE_CSS]: { "#1a1a2e": 2 } } },
  });
  assert.equal(runGate(root).code, 0);
});

test("one more of a baselined hex than its frozen count is refused", () => {
  const root = makeTree({
    css: `.a { color: #1a1a2e; }\n.b { color: #1a1a2e; }\n.c { color: #1a1a2e; }\n`,
    baseline: { counts: { [PROBE_CSS]: { "#1a1a2e": 2 } } },
  });
  const { code, out } = runGate(root);
  assert.equal(code, 1);
  assert.match(out, /3 present, 2 grandfathered/);
});

test("--freeze refuses to raise a hex count without --allow-increase", () => {
  const root = makeTree({
    css: `.a { color: #1a1a2e; }\n.b { color: #1a1a2e; }\n`,
    baseline: { counts: { [PROBE_CSS]: { "#1a1a2e": 1 } } },
  });
  const refused = runGate(root, "--freeze");
  assert.equal(refused.code, 1);
  assert.match(refused.out, /refusing to freeze/);

  const forced = runGate(root, "--freeze", "--allow-increase");
  assert.equal(forced.code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(root, "baseline.json"), "utf8"));
  assert.equal(written.counts[PROBE_CSS]["#1a1a2e"], 2);
});

test("a missing baseline exits 2, not 1, unless --freeze is given", () => {
  const root = makeTree({ css: `.a { color: red; }\n`, baseline: null });
  const { code, out } = runGate(root);
  assert.equal(code, 2);
  assert.match(out, /baseline\.json is missing/);
  assert.equal(runGate(root, "--freeze").code, 0);
});

test("a tokens file missing a ladder refuses to run half-blind, exit 2", () => {
  const root = makeTree({ css: `.a { font-size: 13px; }\n` });
  fs.writeFileSync(path.join(root, "tokens.css"), ":root { --color-ink: #1a1a2e; }\n");
  const { code, out } = runGate(root);
  assert.equal(code, 2);
  assert.match(out, /refusing to run half-blind/);
});

test("the ladders are read from the tokens file, never retyped in the gate", () => {
  const root = makeTree({ css: `.a { border-radius: 10px; }\n` });
  assert.equal(runGate(root).code, 1);
  fs.appendFileSync(path.join(root, "tokens.css"), ":root { --radius-chip: 10px; }\n");
  assert.equal(runGate(root).code, 0, "adding a token to the tokens file must legalise its value the same second");
});

test("React inline styles are the same bypass in camelCase", () => {
  const root = makeTree({
    css: "",
    tsx: `export const A = () => <div style={{ fontSize: 13, borderRadius: 10, boxShadow: "0 8px 24px rgba(23,23,23,.12)" }} />;\n`,
  });
  const { code, out } = runGate(root);
  assert.equal(code, 1);
  assert.match(out, /inline fontSize 13/);
  assert.match(out, /off-ladder inline borderRadius 10/);
  assert.match(out, /raw inline shadow color/);
});

test("inline styles drawn from tokens pass", () => {
  const root = makeTree({
    css: "",
    tsx: `export const A = () => <div style={{ fontSize: "var(--text-sm)", borderRadius: 12, boxShadow: "var(--shadow-card)" }} />;\n`,
  });
  assert.equal(runGate(root).code, 0);
});

test("a DIFFERENT off-ladder value in a grandfathered file still fails", () => {
  const root = makeTree({
    css: `.a { font-size: 13px; }\n.b { font-size: 15px; }\n`,
    baseline: { counts: { [PROBE_CSS]: { "font-size:13px": 1 } } },
  });
  const { code, out } = runGate(root);
  assert.equal(code, 1);
  assert.match(out, /raw font-size 15px/);
  assert.doesNotMatch(out, /raw font-size 13px/);
});

test("a px fallback inside var() is legal for font-size and radius", () => {
  const root = makeTree({ css: `.a { font-size: var(--text-sm, 13px); border-radius: var(--radius-card, 10px); }\n` });
  assert.equal(runGate(root).code, 0);
});

test("a raw token hex under node_modules is skipped but the same hex beside it is not", () => {
  const vendored = makeTree({
    css: `.a { color: red; }\n`,
    extra: { "src/node_modules/pkg/vendor.css": `.v { color: #1a1a2e; }\n` },
  });
  assert.equal(runGate(vendored).code, 0);

  const ours = makeTree({
    css: `.a { color: red; }\n`,
    extra: { "src/pkg/vendor.css": `.v { color: #1a1a2e; }\n` },
  });
  const { code, out } = runGate(ours);
  assert.equal(code, 1);
  assert.match(out, /raw #1a1a2e -> use var\(--color-ink\)/);
});

test("every skipped directory name is skipped, and a FILE with that name is still scanned", () => {
  for (const dir of ["node_modules", ".git", "dist", "build", "coverage", ".next"]) {
    const root = makeTree({ css: "", extra: { [`src/${dir}/vendor.css`]: `.v { color: #1a1a2e; }\n` } });
    assert.equal(runGate(root).code, 0, `${dir} should not be scanned`);
  }
  const file = makeTree({ css: "", extra: { "src/build.css": `.v { color: #1a1a2e; }\n` } });
  assert.equal(runGate(file).code, 1, "build.css is a source file, not a build directory");
});

test("missing --tokens or --scope prints usage and exits 2", () => {
  const r = spawnSync(process.execPath, [GATE, "--tokens", "tokens.css"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /usage:/);
});

// The three codes are the whole contract a CI step relies on: a caller that
// reads "non-zero" as "drift found" must not be handed a crash instead.
test("exit 0 is clean, exit 1 is a violation, exit 2 is a gate that could not run", () => {
  const clean = makeTree({ css: `.a { color: var(--color-ink); }\n` });
  assert.equal(runGate(clean).code, 0);

  const violating = makeTree({ css: `.a { color: #1a1a2e; }\n` });
  assert.equal(runGate(violating).code, 1);

  const root = makeTree({ css: `.a { color: #1a1a2e; }\n` });
  const at = (...flags) => spawnSync(process.execPath, [GATE, ...flags], { encoding: "utf8" });
  const tokens = path.join(root, "tokens.css");
  const scope = path.join(root, "src");
  const baseline = path.join(root, "baseline.json");

  const missingScope = at("--tokens", tokens, "--scope", path.join(root, "srcc"), "--baseline", baseline);
  assert.equal(missingScope.status, 2, "a typo'd scope directory is not a violation");
  assert.match(missingScope.stderr, /scope directory not found/);

  const missingTokens = at("--tokens", path.join(root, "tokns.css"), "--scope", scope, "--baseline", baseline);
  assert.equal(missingTokens.status, 2);
  assert.match(missingTokens.stderr, /tokens file not found/);

  const unknownFlag = at("--tokens", tokens, "--scope", scope, "--baseline", baseline, "--strict");
  assert.equal(unknownFlag.status, 2);
  assert.match(unknownFlag.stderr, /unrecognized argument "--strict"/);
});

test("--freeze refusing to raise the ceiling stays exit 1: the gate ran and said no", () => {
  const root = makeTree({
    css: `.a { font-size: 13px; }\n.b { font-size: 13px; }\n`,
    baseline: { counts: { [PROBE_CSS]: { "font-size:13px": 1 } } },
  });
  assert.equal(runGate(root, "--freeze").code, 1);
});

// ── The optional ladders: spacing, border width, duration, breakpoint ──
// Each one is read from the tokens file by name, like the font-size and
// radius ladders, and switches on only when the tokens file declares it.
const MORE_TOKENS = `:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-4: 16px;
  --border-thin: 1px;
  --border-thick: 2px;
  --duration-fast: 150ms;
  --duration-slow: 0.3s;
  --breakpoint-md: 768px;
  --breakpoint-lg: 1024px;
}
`;

function runWithMore(css, tsx = null) {
  const root = makeTree({ css, tsx });
  fs.appendFileSync(path.join(root, "tokens.css"), MORE_TOKENS);
  return runGate(root);
}

test("off-scale margin, padding and gap are refused and name the nearest spacing token", () => {
  const { code, out } = runWithMore(`.a { padding: 8px 13px; }\n.b { margin-top: -7px; }\n.c { gap: 16px; row-gap: 10px; }\n`);
  assert.equal(code, 1);
  assert.match(out, /probe\.css:1 off-scale padding 13px -> use var\(--space-4\)/);
  assert.match(out, /probe\.css:2 off-scale margin-top -7px -> use var\(--space-2\)/);
  assert.match(out, /probe\.css:3 off-scale row-gap 10px -> use var\(--space-2\)/);
  assert.doesNotMatch(out, /gap 16px/);
});

test("spacing on the scale, zero, auto and var() pass", () => {
  const { code } = runWithMore(`.a { padding: 8px 16px; margin: 0 auto; gap: var(--space-1, 5px); margin-left: -4px; }\n`);
  assert.equal(code, 0);
});

test("border and outline widths are held to the border ladder, and a radius token never joins it", () => {
  const root = makeTree({ css: `.a { border: 3px solid red; outline-width: 2px; border-top-width: 12px; }\n` });
  fs.appendFileSync(path.join(root, "tokens.css"), MORE_TOKENS + ":root { --border-radius-pill: 12px; }\n");
  const { code, out } = runGate(root);
  assert.equal(code, 1);
  assert.match(out, /off-scale border 3px -> use var\(--border-thick\)/);
  assert.match(out, /off-scale border-top-width 12px/, "12px is a radius token, not a border width");
  assert.doesNotMatch(out, /outline-width/);
});

test("durations are compared in milliseconds whether written in ms or s", () => {
  const { code, out } = runWithMore(
    `.a { transition: opacity 300ms ease, transform 0.15s ease; }\n.b { animation-duration: 250ms; }\n.c { transition-delay: 0s; }\n`
  );
  assert.equal(code, 1);
  assert.match(out, /probe\.css:2 off-scale animation-duration 250ms -> use var\(--duration-slow\)/);
  assert.doesNotMatch(out, /probe\.css:1 /);
  assert.doesNotMatch(out, /probe\.css:3 /);
});

test("a media query width off the breakpoint ladder is refused; just below a breakpoint is a max-width edge", () => {
  const { code, out } = runWithMore(
    `@media (min-width: 768px) { .a { color: red; } }\n@media (max-width: 767px) { .b { color: red; } }\n@media (max-width: 1023.98px) { .c { color: red; } }\n@media (min-width: 900px) { .d { color: red; } }\n`
  );
  assert.equal(code, 1);
  assert.match(out, /probe\.css:4 off-scale breakpoint 900px -> nearest token --breakpoint-lg/);
  assert.equal((out.match(/off-scale breakpoint/g) ?? []).length, 1);
});

test("a tokens file with no spacing, border, duration or breakpoint tokens leaves those values alone", () => {
  const root = makeTree({ css: `.a { padding: 13px; border: 3px solid red; transition: opacity 250ms; }\n@media (min-width: 900px) { .b { color: red; } }\n` });
  assert.equal(runGate(root).code, 0);
});

test("inline padding, margin and border widths are checked in camelCase too", () => {
  const { code, out } = runWithMore("", `export const A = () => <div style={{ padding: 13, marginTop: "8px", borderWidth: 3 }} />;\n`);
  assert.equal(code, 1);
  assert.match(out, /off-scale inline padding 13 -> use var\(--space-4\)/);
  assert.match(out, /off-scale inline borderWidth 3 -> use var\(--border-thick\)/);
  assert.doesNotMatch(out, /marginTop/);
});

test("an off-scale spacing value is grandfathered by the baseline like any other", () => {
  const root = makeTree({
    css: `.a { padding: 13px; }\n`,
    baseline: { counts: { [PROBE_CSS]: { "padding:13px": 1 } } },
  });
  fs.appendFileSync(path.join(root, "tokens.css"), MORE_TOKENS);
  assert.equal(runGate(root).code, 0);
});

// ── The vouch comment: one hand-typed value accepted in the open, with a reason ──
test("a token-vouch comment with a reason accepts the value on its line and is counted", () => {
  const root = makeTree({ css: `.a { font-size: 13px; } /* token-vouch: matches the embedded widget's own label */\n.b { color: red; }\n` });
  const { code, out } = runGate(root);
  assert.equal(code, 0);
  assert.match(out, /vouched: src\/probe\.css:1 raw font-size 13px .* - matches the embedded widget's own label/);
  assert.match(out, /1 hand-typed value\(s\) vouched for/);
});

test("a token-vouch covers only its own line", () => {
  const root = makeTree({ css: `/* token-vouch: header nudge */\n.a { font-size: 13px; }\n` });
  const { code, out } = runGate(root);
  assert.equal(code, 1);
  assert.match(out, /probe\.css:2 raw font-size 13px/);
});

test("a token-vouch with no reason vouches for nothing and says so", () => {
  const root = makeTree({ css: `.a { border-radius: 10px; } /* token-vouch: */\n` });
  const { code, out } = runGate(root);
  assert.equal(code, 1);
  assert.match(out, /off-ladder border-radius 10px .*token-vouch on this line gives no reason/);
});

test("a // token-vouch works in a script file", () => {
  const root = makeTree({ css: "", tsx: `export const A = () => <div style={{ fontSize: 13 }} />; // token-vouch: legacy email template\n` });
  assert.equal(runGate(root).code, 0);
});

test("--freeze leaves vouched values out of the baseline", () => {
  const root = makeTree({ css: `.a { font-size: 13px; } /* token-vouch: print stylesheet */\n.b { font-size: 15px; }\n`, baseline: null });
  assert.equal(runGate(root, "--freeze").code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(root, "baseline.json"), "utf8"));
  assert.deepEqual(written.counts[PROBE_CSS], { "font-size:15px": 1 });
});

test("a clean run with nothing vouched prints no vouch line", () => {
  const root = makeTree({ css: `.a { font-size: 12px; } /* token-vouch: not needed */\n` });
  const { code, out } = runGate(root);
  assert.equal(code, 0);
  assert.doesNotMatch(out, /vouch/);
});

// ── Allow-files: whole files that are not yours to hold to the tokens ──
test("--allow-file skips a matching file and reports how many it skipped", () => {
  const root = makeTree({ css: `.a { color: #1a1a2e; }\n`, extra: { "src/specimens/swatches.css": `.s { color: #1a1a2e; }\n` } });
  const r = runGate(root, "--allow-file", "probe.css", "--allow-file", "specimens/**");
  assert.equal(r.code, 0);
  assert.match(r.out, /2 file\(s\) skipped by --allow-file/);
});

test("an --allow-file glob with a slash is matched against the path under --scope", () => {
  const root = makeTree({ css: "", extra: { "src/a/vendor.css": `.v { color: #1a1a2e; }\n`, "src/b/vendor.css": `.v { color: #1a1a2e; }\n` } });
  const { code, out } = runGate(root, "--allow-file", "a/*.css");
  assert.equal(code, 1);
  assert.match(out, /b\/vendor\.css:1 raw #1a1a2e/);
  assert.doesNotMatch(out, /a\/vendor\.css:1/);
});

test("a glob without a slash matches the file name at any depth", () => {
  const root = makeTree({ css: "", extra: { "src/deep/er/print.css": `.p { font-size: 13px; }\n` } });
  assert.equal(runGate(root, "--allow-file", "print.css").code, 0);
});

test("an --allow-file pattern that matches nothing is named, and the run still grades", () => {
  const root = makeTree({ css: `.a { font-size: 13px; }\n` });
  const { code, out } = runGate(root, "--allow-file", "specimen.css");
  assert.equal(code, 1);
  assert.match(out, /--allow-file "specimen\.css" matched no file/);
});

test("--allow-file with no pattern is a usage error", () => {
  const root = makeTree({ css: "" });
  assert.equal(runGate(root, "--allow-file").code, 2);
});

test("an unindented declaration reports its own line, and a vouch on it applies", () => {
  const css = `.a {\nfont-size: 13px;\nborder-radius: 10px;\nbox-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);\n}\n`;
  const { code, out } = runGate(makeTree({ css }));
  assert.equal(code, 1);
  assert.match(out, /probe\.css:2 raw font-size 13px/);
  assert.match(out, /probe\.css:3 off-ladder border-radius 10px/);
  assert.match(out, /probe\.css:4 raw shadow color/);

  const vouched = css.replace(/;\n/g, "; /* token-vouch: print sheet */\n");
  assert.equal(runGate(makeTree({ css: vouched })).code, 0);
});

test("a letter-spacing or word-spacing token never joins the spacing ladder", () => {
  const root = makeTree({ css: `.a { padding: 13px; }\n` });
  fs.appendFileSync(path.join(root, "tokens.css"), ":root { --space-2: 8px; --letter-spacing-wide: 13px; --word-spacing-loose: 13px; }\n");
  const { code, out } = runGate(root);
  assert.equal(code, 1);
  assert.match(out, /off-scale padding 13px -> use var\(--space-2\)/);
});
