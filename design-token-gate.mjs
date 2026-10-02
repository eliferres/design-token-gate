#!/usr/bin/env node
/*
 * DESIGN-TOKEN GATE: every shipped surface should draw its colors, type
 * sizes, corners, and shadows from one tokens file, or the build fails.
 *
 * RULE 1 (hex tokens). Any hex color that IS a named custom property in your
 * tokens file may not appear raw in scanned source - it must be the var().
 * A raw hex is legal only as a var() fallback: var(--x, #171717).
 *
 * RULE 2 (ladders). font-size, radius, and box-shadow are the three values
 * developers eyeball past code review even when the hex rule is airtight:
 * a stray 13px next to a --text-* ladder of 10/12/14/16/20, an off-ladder
 * 7px corner, a hand-typed rgba() lift instead of a shadow token. Both
 * numeric ladders and the shadow token list are READ FROM your tokens file
 * AT RUNTIME, never retyped here - add a size to the ladder there and this
 * gate accepts it the same second.
 *
 * Which custom properties feed which ladder is decided by name, not by
 * value, because two different ladders can share the same unit (a font
 * size and a radius are both "some number of px"). A property is read into
 * the font-size ladder if its name contains "text" or "font"; into the
 * radius ladder if its name contains "radius" or "corner"; into the shadow
 * token list if its name contains "shadow" or "elev". This is a naming
 * convention, not a law of CSS - name your tokens accordingly, or the gate
 * has no ladder to check against and refuses to run half-blind (below).
 *
 * RULE 3 (optional ladders). Spacing (margin, padding, gap), border and
 * outline widths, transition and animation durations, and media-query
 * widths are held to ladders read the same way: "space", "spacing", "gap"
 * or "gutter" in the name for spacing; "border", "stroke" or "outline"
 * without "radius" for line weights; "duration" or "delay" for durations
 * (ms or s, compared in ms); "breakpoint", "screen" or "bp-" for media
 * widths. Unlike rule 2 these are optional: a tokens file that declares no
 * spacing tokens gets no spacing check, rather than a refusal.
 *
 * ── The grandfather list ──
 * Older codebases have pre-rule debt: switching the gate on for a repo that
 * already hardcodes hundreds of values is how the gate never gets adopted.
 * Debt is FROZEN in a baseline JSON as per-file, per-value counts ("file.css"
 * -> "font-size:13px": 42). Rule 1's raw hex values are grandfathered the
 * same way, keyed by the raw hex string itself ("file.css" -> "#1a1a2e": 7)
 * - a hardcoded token color is exactly as much pre-existing debt as an
 * off-ladder font size, and freezing one rule but not the other is how a
 * legacy tree full of raw hexes "passes" the gate right up until CI is
 * wired and it fails on day one. Line numbers are deliberately NOT part of
 * either key - moving a declaration must not fail the build; adding a 43rd
 * 13px (or an 8th #1a1a2e) must. --freeze re-derives the baseline from the
 * current tree and refuses to raise any count without --allow-increase, so
 * the debt only shrinks.
 *
 * Usage:
 *   design-token-gate --tokens tokens.css --scope src [--baseline baseline.json] [--freeze] [--allow-increase]
 *
 * Exit 0 clean. Exit 1 on a violation not covered by the baseline, and on a
 * --freeze that would raise the ceiling: the gate ran and says no. Exit 2
 * when the gate could not run at all - bad arguments, a missing tokens file
 * or scope directory, a tokens file with no ladder to read, a missing
 * baseline without --freeze. A caller that treats "non-zero" as "drift
 * found" would otherwise read a typo in a path as a passing check.
 * Zero dependencies, Node 18+, ESM.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, join, basename } from "node:path";

// Usage text names the gate the way it was actually invoked: the installed
// command by its own name, a checkout run as "node design-token-gate.mjs".
const invokedAs = basename(process.argv[1] ?? "design-token-gate");
const INVOCATION = invokedAs.endsWith(".mjs") ? `node ${invokedAs}` : invokedAs;

function version() {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  return pkg.version;
}

function parseArgs(argv) {
  const out = { freeze: false, allowIncrease: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tokens") out.tokens = argv[++i];
    else if (a === "--scope") out.scope = argv[++i];
    else if (a === "--baseline") out.baseline = argv[++i];
    else if (a === "--freeze") out.freeze = true;
    else if (a === "--allow-increase") out.allowIncrease = true;
    else if (a === "--version") {
      console.log(`design-token-gate ${version()}`);
      process.exit(0);
    } else {
      console.error(`design-token-gate: unrecognized argument "${a}"`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.tokens || !args.scope) {
  console.error(`usage: ${INVOCATION} --tokens tokens.css --scope src [--baseline baseline.json] [--freeze] [--allow-increase]`);
  process.exit(2);
}

const TOKENS_FILE = resolve(args.tokens);
const SCOPE_DIR = resolve(args.scope);
const BASELINE_FILE = resolve(args.baseline ?? "design-token-baseline.json");
// Baseline keys and report paths are relative to the baseline file's own
// directory, never to process.cwd() - the gate must report the same file
// path no matter where it is invoked from.
const ANCHOR = resolve(BASELINE_FILE, "..");
const relPath = (file) => relative(ANCHOR, file);

if (!existsSync(TOKENS_FILE)) {
  console.error(`design-token-gate: tokens file not found at ${args.tokens}`);
  process.exit(2);
}
if (!existsSync(SCOPE_DIR)) {
  console.error(`design-token-gate: scope directory not found at ${args.scope}`);
  process.exit(2);
}

const tokensSrc = readFileSync(TOKENS_FILE, "utf8");

// Rule 1's map: every named hex, first declaration wins on a duplicate value.
const tokenByHex = new Map();
for (const m of tokensSrc.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/gi)) {
  const hex = m[2].toLowerCase();
  if (!tokenByHex.has(hex)) tokenByHex.set(hex, m[1]);
}

// Rule 2's ladders, built from property NAME (see header comment for why).
function ladderFrom(nameTest) {
  const out = new Map(); // px value -> token name
  for (const m of tokensSrc.matchAll(/(--[a-z0-9-]+):\s*(\d+(?:\.\d+)?)px\b/gi)) {
    if (!nameTest.test(m[1])) continue;
    const px = parseFloat(m[2]);
    if (!out.has(px)) out.set(px, m[1]);
  }
  return out;
}
const FONT_LADDER = ladderFrom(/text|font/i);
const RADIUS_LADDER = ladderFrom(/radius|corner/i);
const SHADOW_TOKENS = [...tokensSrc.matchAll(/(--[a-z0-9-]+)\s*:/gi)]
  .map((m) => m[1])
  .filter((name) => /shadow|elev/i.test(name));

if (!FONT_LADDER.size || !RADIUS_LADDER.size || !SHADOW_TOKENS.length) {
  console.error(
    "design-token-gate: could not find a font-size ladder, a radius ladder, and a shadow token in " +
    `${args.tokens} - refusing to run half-blind. Name font tokens with "text" or "font", radius ` +
    'tokens with "radius" or "corner", and shadow tokens with "shadow" or "elev".'
  );
  process.exit(2);
}

// ── The optional ladders: spacing, border width, duration, breakpoint ──
// Same contract as the two ladders above (values read from the tokens file
// by property name, never retyped here), held as data so adding a group is
// one more row. They are optional where font-size and radius are not:
// plenty of token systems stop at color and type, and a gate that refused to
// run on those would break every existing setup the day it upgraded. A group
// whose tokens are absent is simply not checked.
const SIDES = "(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?";
const OPTIONAL_LADDERS = [
  {
    group: "spacing",
    isToken: (name) => /space|spacing|gap|gutter/i.test(name),
    unit: "px",
    cssProp: new RegExp(`^(?:margin${SIDES}|padding${SIDES}|gap|row-gap|column-gap)$`, "i"),
    jsProp: /^(?:margin|padding)(?:Top|Right|Bottom|Left|Inline|Block|InlineStart|InlineEnd|BlockStart|BlockEnd)?$|^(?:gap|rowGap|columnGap)$/,
  },
  {
    group: "border",
    // "--border-radius-card" is a corner, not a line weight.
    isToken: (name) => /border|stroke|outline/i.test(name) && !/radius|corner/i.test(name),
    unit: "px",
    cssProp: /^(?:border(?:-(?:top|right|bottom|left))?(?:-width)?|outline(?:-width|-offset)?)$/i,
    jsProp: /^(?:border(?:Top|Right|Bottom|Left)?Width|outlineWidth|outlineOffset)$/,
  },
  {
    group: "duration",
    isToken: (name) => /duration|delay/i.test(name),
    unit: "ms",
    cssProp: /^(?:transition|transition-duration|transition-delay|animation|animation-duration|animation-delay)$/i,
    jsProp: null,
  },
  {
    // Read from @media preludes rather than declarations; see scanBreakpoints.
    group: "breakpoint",
    isToken: (name) => /breakpoint|screen|\bbp-/i.test(name),
    unit: "px",
    cssProp: null,
    jsProp: null,
  },
];

// A duration ladder is kept in milliseconds so 0.3s and 300ms are one step.
function toLadderUnit(num, unit, want) {
  if (want === "px") return unit === "px" ? num : null;
  if (unit === "ms") return num;
  if (unit === "s") return num * 1000;
  return null;
}

for (const ladder of OPTIONAL_LADDERS) {
  ladder.values = new Map(); // number in ladder.unit -> token name
  for (const m of tokensSrc.matchAll(/(--[a-z0-9-]+):\s*(\d*\.?\d+)(px|ms|s)\b/gi)) {
    if (!ladder.isToken(m[1])) continue;
    const v = toLadderUnit(parseFloat(m[2]), m[3].toLowerCase(), ladder.unit);
    if (v !== null && !ladder.values.has(v)) ladder.values.set(v, m[1]);
  }
}
const ACTIVE_LADDERS = OPTIONAL_LADDERS.filter((l) => l.values.size);
const BREAKPOINTS = ACTIVE_LADDERS.find((l) => l.group === "breakpoint");
const scaleText = (ladder) => `${ladder.group} scale: ${[...ladder.values.keys()].sort((a, b) => a - b).join("/")}${ladder.unit}`;

function nearest(ladder, px) {
  let best = null;
  for (const [v, name] of ladder) {
    if (best === null || Math.abs(v - px) < Math.abs(best[0] - px)) best = [v, name];
  }
  return best; // [px, tokenName]
}

// Dependencies and build output are not yours to fix: pointing --scope at a
// project root and getting a report on vendored CSS is how the gate gets
// switched off. A directory named on this list is never descended into.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      yield* walk(p);
    } else if (/\.(tsx?|jsx?|css)$/.test(name)) yield p;
  }
}

const scopedFiles = [...walk(SCOPE_DIR)].filter((f) => f !== TOKENS_FILE);

// ── Scanning: comments are blanked (not deleted) before matching, for both
// rules, so a commented-out declaration never trips the gate and every line
// number stays exact.
function blankComments(src, isCss) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  if (!isCss) out = out.replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, (full, keep) => keep + " ".repeat(full.length - keep.length));
  return out;
}

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;
// A px literal is legal as the fallback half of var(--token, 13px).
const isVarFallback = (value) => /var\(\s*--[a-z0-9-]+\s*,/i.test(value);
// A length or time literal standing on its own, never the tail of a name
// like translate3d or a hex digit run.
const LITERAL = /(?<![\w.#-])(-?\d*\.?\d+)(px|ms|s)\b/gi;

// Every literal in one CSS declaration checked against one optional ladder.
// Zero passes in any unit, and the sign is ignored: a -8px pull is the 8px
// step of the spacing scale.
function checkLadderValue(ladder, prop, value, line, add) {
  if (isVarFallback(value)) return;
  for (const lit of value.matchAll(LITERAL)) {
    const v = toLadderUnit(parseFloat(lit[1]), lit[2].toLowerCase(), ladder.unit);
    if (v === null || v === 0 || ladder.values.has(Math.abs(v))) continue;
    const [, token] = nearest(ladder.values, Math.abs(v));
    add(`${prop}:${lit[0]}`, line, `off-scale ${prop} ${lit[0]} -> use var(${token}) (${scaleText(ladder)})`);
  }
}

// Custom properties do not work inside a media query, so a breakpoint token
// can only be honored by typing its value; the gate checks that the typed
// width is one of them. A max-width one step under a breakpoint (767px or
// 767.98px under 768px) is the usual way to end a range without overlap, so
// it counts as that breakpoint.
function scanBreakpoints(src, add) {
  for (const media of src.matchAll(/@media\b[^{;]*/gi)) {
    for (const cond of media[0].matchAll(/\([^()]*\)/g)) {
      if (!/\bwidth\b/i.test(cond[0])) continue;
      const isMax = /max-width|width\s*</i.test(cond[0]) || /px\s*>/i.test(cond[0]);
      for (const lit of cond[0].matchAll(/(\d*\.?\d+)px\b/gi)) {
        const v = parseFloat(lit[1]);
        const onLadder = [...BREAKPOINTS.values.keys()].some(
          (b) => b === v || (isMax && (b - v === 1 || Math.abs(b - v - 0.02) < 1e-9))
        );
        if (onLadder) continue;
        const [, token] = nearest(BREAKPOINTS.values, v);
        add(`breakpoint:${lit[0]}`, lineOf(src, media.index + cond.index), `off-scale breakpoint ${lit[0]} -> nearest token ${token} (${scaleText(BREAKPOINTS)})`);
      }
    }
  }
}

// ── The vouch comment. Some hand-typed values are right: a third-party
// widget's frame, a print stylesheet, an email template. A comment on the
// same line, /* token-vouch: <reason> */ (or // in a script), accepts every
// value on that line. The reason is required and every vouch is printed with
// it, so an exception is a visible, reviewable line in the diff and the
// report rather than a hole. Vouched values never reach the baseline.
const VOUCH = /(?:\/\*|\/\/)\s*token-vouch:(.*?)(?:\*\/|$)/;
const vouched = [];

function vouchesIn(raw) {
  const byLine = new Map(); // line number -> reason ("" when none was given)
  raw.split("\n").forEach((line, i) => {
    const m = line.match(VOUCH);
    if (m) byLine.set(i + 1, m[1].trim());
  });
  return byLine;
}

function scanFile(file) {
  const rel = relPath(file);
  const isCss = file.endsWith(".css");
  const raw = readFileSync(file, "utf8");
  const vouchByLine = vouchesIn(raw);
  const src = blankComments(raw, isCss);
  const found = [];
  const add = (key, line, message) => {
    const reason = vouchByLine.get(line);
    if (reason) vouched.push({ file: rel, line, message, reason });
    else if (reason === "") found.push({ file: rel, key, line, message: `${message} (the token-vouch on this line gives no reason, so it vouches for nothing)` });
    else found.push({ file: rel, key, line, message });
  };

  // ── Rule 1: raw hex that names a token. Keyed by the raw hex string, the
  // same shape rule 2's ladder hits use, so both fold into one baseline. ──
  src.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
      const hex = m[0].toLowerCase();
      const token = tokenByHex.get(hex);
      if (!token) continue;
      const before = line.slice(0, m.index);
      const isFallback = /var\(\s*--[a-z0-9-]*\s*,\s*$/i.test(before);
      if (!isFallback) add(hex, i + 1, `raw ${m[0]} -> use var(${token})`);
    }
  });

  // ── Rule 2: the two ladders + the shadow tokens ──
  if (isCss) {
    for (const m of src.matchAll(/(^|[;{}\s])font-size\s*:\s*([^;}]+)/gi)) {
      const value = m[2].trim();
      if (isVarFallback(value)) continue;
      const px = value.match(/(\d+(?:\.\d+)?)px/);
      if (!px) continue;
      if (FONT_LADDER.has(parseFloat(px[1]))) continue;
      const [, token] = nearest(FONT_LADDER, parseFloat(px[1]));
      add(`font-size:${px[1]}px`, lineOf(src, m.index), `raw font-size ${px[1]}px -> use var(${token}) (the font-size ladder)`);
    }
    for (const m of src.matchAll(/(^|[;{}\s])(border(?:-(?:top|bottom)-(?:left|right))?-radius)\s*:\s*([^;}]+)/gi)) {
      const prop = m[2];
      const value = m[3].trim();
      if (isVarFallback(value)) continue;
      for (const p of value.matchAll(/(\d+(?:\.\d+)?)px/g)) {
        const v = parseFloat(p[1]);
        if (v === 0 || RADIUS_LADDER.has(v)) continue;
        const [, token] = nearest(RADIUS_LADDER, v);
        add(`${prop.toLowerCase()}:${p[1]}px`, lineOf(src, m.index), `off-ladder ${prop} ${p[1]}px -> use var(${token}) (ladder: ${[...RADIUS_LADDER.keys()].sort((a, b) => a - b).join("/")})`);
      }
    }
    for (const m of src.matchAll(/(^|[;{}\s])box-shadow\s*:\s*([^;}]+)/gi)) {
      const value = m[2].trim();
      if (value === "none" || isVarFallback(value)) continue;
      if (!/rgba?\(|#[0-9a-fA-F]{3,8}\b/.test(value)) continue;
      const norm = value.replace(/\s+/g, " ").toLowerCase();
      add(`box-shadow:${norm}`, lineOf(src, m.index), `raw shadow color -> use var(${SHADOW_TOKENS[0]})${SHADOW_TOKENS[1] ? ` / var(${SHADOW_TOKENS[1]})` : ""}`);
    }
    for (const m of src.matchAll(/(^|[;{}\s])([a-z-]+)\s*:\s*([^;{}]+)/gi)) {
      const prop = m[2].toLowerCase();
      const ladder = ACTIVE_LADDERS.find((l) => l.cssProp?.test(prop));
      if (ladder) checkLadderValue(ladder, prop, m[3].trim(), lineOf(src, m.index + m[1].length), add);
    }
    if (BREAKPOINTS) scanBreakpoints(src, add);
  } else {
    // Inline JS/TS object styles are the same bypass wearing camelCase.
    for (const m of src.matchAll(/\bfontSize\s*:\s*(?:"(\d+(?:\.\d+)?)px"|'(\d+(?:\.\d+)?)px'|(\d+(?:\.\d+)?))\s*[,}]/g)) {
      const raw = m[1] ?? m[2] ?? m[3];
      if (FONT_LADDER.has(parseFloat(raw))) continue;
      const [, token] = nearest(FONT_LADDER, parseFloat(raw));
      add(`fontSize:${raw}`, lineOf(src, m.index), `inline fontSize ${raw} -> use var(${token}) (the font-size ladder)`);
    }
    for (const m of src.matchAll(/\bborderRadius\s*:\s*(?:"(\d+(?:\.\d+)?)px"|'(\d+(?:\.\d+)?)px'|(\d+(?:\.\d+)?))\s*[,}]/g)) {
      const raw = m[1] ?? m[2] ?? m[3];
      const v = parseFloat(raw);
      if (v === 0 || RADIUS_LADDER.has(v)) continue;
      const [, token] = nearest(RADIUS_LADDER, v);
      add(`borderRadius:${raw}`, lineOf(src, m.index), `off-ladder inline borderRadius ${raw} -> use var(${token}) (ladder: ${[...RADIUS_LADDER.keys()].sort((a, b) => a - b).join("/")})`);
    }
    for (const m of src.matchAll(/\bboxShadow\s*:\s*(["'])([^"']+)\1/g)) {
      const value = m[2];
      if (value === "none" || !/rgba?\(|#[0-9a-fA-F]{3,8}\b/.test(value)) continue;
      const norm = value.replace(/\s+/g, " ").toLowerCase();
      add(`boxShadow:${norm}`, lineOf(src, m.index), `raw inline shadow color -> use var(${SHADOW_TOKENS[0]})`);
    }
    for (const m of src.matchAll(/\b([a-zA-Z]+)\s*:\s*(?:"(-?\d+(?:\.\d+)?)px"|'(-?\d+(?:\.\d+)?)px'|(-?\d+(?:\.\d+)?))\s*[,}]/g)) {
      const ladder = ACTIVE_LADDERS.find((l) => l.jsProp?.test(m[1]));
      if (!ladder) continue;
      const raw = m[2] ?? m[3] ?? m[4];
      const v = Math.abs(parseFloat(raw));
      if (v === 0 || ladder.values.has(v)) continue;
      const [, token] = nearest(ladder.values, v);
      add(`${m[1]}:${raw}`, lineOf(src, m.index), `off-scale inline ${m[1]} ${raw} -> use var(${token}) (${scaleText(ladder)})`);
    }
  }
  return found;
}

const allHits = scopedFiles.flatMap(scanFile);

// Fold to per-file, per-value counts - the shape the baseline freezes. Rule
// 1's raw hex strings and rule 2's ladder keys share this one table: both
// are grandfathered debt under the same shrink-only contract.
const currentCounts = {};
for (const h of allHits) {
  (currentCounts[h.file] ??= {})[h.key] = (currentCounts[h.file]?.[h.key] ?? 0) + 1;
}

let baseline = { counts: {} };
let baselineExists = true;
try {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
} catch {
  baselineExists = false;
  if (!args.freeze) {
    console.error(`design-token-gate: ${relPath(BASELINE_FILE)} is missing or unreadable - run with --freeze to create it.`);
    process.exit(2);
  }
}
const baseCounts = baseline.counts ?? {};

if (args.freeze) {
  // The first freeze IS the debt ceiling; only later freezes have to ratchet down.
  const increases = [];
  if (baselineExists) {
    for (const [file, keys] of Object.entries(currentCounts)) {
      for (const [key, n] of Object.entries(keys)) {
        const was = baseCounts[file]?.[key] ?? 0;
        if (n > was) increases.push(`  ${file} - ${key}: ${was} -> ${n}`);
      }
    }
  }
  if (increases.length && !args.allowIncrease) {
    console.error("design-token-gate: refusing to freeze - this would raise the debt ceiling:\n");
    for (const i of increases) console.error(i);
    console.error("\nThe baseline only shrinks. Fix the new violations, or re-run with --allow-increase and say why in the commit.");
    process.exit(1);
  }
  const sorted = {};
  for (const file of Object.keys(currentCounts).sort()) {
    sorted[file] = Object.fromEntries(Object.entries(currentCounts[file]).sort(([a], [b]) => a.localeCompare(b)));
  }
  const total = allHits.length;
  writeFileSync(BASELINE_FILE, JSON.stringify({
    law: "Frozen grandfather list for the design-token gate (rule 1's raw hex values and rule 2's font-size ladder, radius ladder, shadow tokens). Counts only go down.",
    rule: "Keyed by file -> offending value -> count. Line numbers are deliberately absent: moving a declaration must not fail the build, adding another one must.",
    refreeze: "node design-token-gate.mjs --tokens ... --scope ... --freeze (after removing violations)",
    total,
    counts: sorted,
  }, null, 2) + "\n");
  console.log(`design-token-gate: baseline frozen - ${total} grandfathered violation(s) across ${Object.keys(sorted).length} file(s).`);
  process.exit(0);
}

// Anything above the frozen count is new work, and new work has no excuse.
const overflow = [];
for (const [file, keys] of Object.entries(currentCounts)) {
  for (const [key, n] of Object.entries(keys)) {
    const allowed = baseCounts[file]?.[key] ?? 0;
    if (n <= allowed) continue;
    const examples = allHits.filter((h) => h.file === file && h.key === key);
    if (allowed === 0) {
      overflow.push(`${file}:${examples[0].line} ${examples[0].message}`);
      continue;
    }
    // Already-grandfathered value, one too many: the key is line-independent, so
    // name the lines it lives on (capped) and let git diff point at the new one.
    const shown = examples.slice(0, 10).map((h) => h.line).join(", ");
    const more = examples.length > 10 ? `, +${examples.length - 10} more` : "";
    overflow.push(`${file} ${examples[0].message} - ${n} present, ${allowed} grandfathered (lines ${shown}${more})`);
  }
}

if (vouched.length) {
  console.log(`design-token-gate: ${vouched.length} hand-typed value(s) vouched for:`);
  for (const v of vouched) console.log(`  vouched: ${v.file}:${v.line} ${v.message} - ${v.reason}`);
}

if (overflow.length) {
  console.error(`design-token-gate: ${overflow.length} violation(s) - ${args.tokens} owns the tokens and ladders:`);
  for (const o of overflow) console.error("  " + o);
  console.error(`\nGrandfathered debt is frozen in ${relPath(BASELINE_FILE)} - that list only shrinks.`);
  process.exit(1);
}

const grandfathered = Object.values(baseCounts).reduce((sum, keys) => sum + Object.values(keys).reduce((a, b) => a + b, 0), 0);
const vouchNote = vouched.length ? `, ${vouched.length} hand-typed value(s) vouched for` : "";
console.log(`design-token-gate: clean - every token value flows from ${args.tokens} (${grandfathered} grandfathered violation(s) still owed${vouchNote}).`);
