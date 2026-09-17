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

function makeTree({ css = "", tsx = null, baseline = { counts: {} } }) {
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

test("a missing baseline fails loudly unless --freeze is given", () => {
  const root = makeTree({ css: `.a { color: red; }\n`, baseline: null });
  const { code, out } = runGate(root);
  assert.equal(code, 1);
  assert.match(out, /baseline\.json is missing/);
  assert.equal(runGate(root, "--freeze").code, 0);
});

test("a tokens file missing a ladder refuses to run half-blind", () => {
  const root = makeTree({ css: `.a { font-size: 13px; }\n` });
  fs.writeFileSync(path.join(root, "tokens.css"), ":root { --color-ink: #1a1a2e; }\n");
  const { code, out } = runGate(root);
  assert.equal(code, 1);
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

test("missing --tokens or --scope prints usage and exits 1", () => {
  const r = spawnSync(process.execPath, [GATE, "--tokens", "tokens.css"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /usage:/);
});
