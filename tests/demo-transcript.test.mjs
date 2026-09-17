/*
 * The demo receipt. demo/transcript.json is what the README walkthrough and
 * demo/terminal.svg show a reader, so it has to be what the commands really
 * print. Every entry is replayed with bash inside a throwaway copy of the
 * repo and compared byte for byte, and every row of the picture has to trace
 * back to that transcript. Run the suite with UPDATE_DEMO_TRANSCRIPT=1 to
 * rewrite demo/transcript.json from the real run; never hand-edit it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TRANSCRIPT = path.join(REPO, "demo", "transcript.json");
const PICTURE = path.join(REPO, "demo", "terminal.svg");
const CHECKOUT = "/path/to/checkout";

const entries = JSON.parse(fs.readFileSync(TRANSCRIPT, "utf8"));

// The copy keeps the repo layout so relative paths in the commands still
// resolve; .git and node_modules are pure weight.
function copyRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-token-gate-demo-"));
  const checkout = path.join(root, "checkout");
  fs.cpSync(REPO, checkout, {
    recursive: true,
    filter: (src) => !/(^|\/)(\.git|node_modules)(\/|$)/.test(src),
  });
  return checkout;
}

// macOS resolves /var to /private/var, so the copy has two path spellings and
// either could reach the output. Longest first, so neither hides the other.
function normalize(text, checkout) {
  const forms = [...new Set([checkout, fs.realpathSync(checkout)])].sort((a, b) => b.length - a.length);
  let out = text;
  for (const form of forms) out = out.split(form).join(CHECKOUT);
  return out;
}

function replay(cmd, checkout) {
  const r = spawnSync("bash", ["-c", cmd], { cwd: checkout, encoding: "utf8" });
  return {
    out: normalize(`${r.stdout}${r.stderr}`, checkout).replace(/\n$/, ""),
    status: r.status,
  };
}

test("every transcript entry replays exactly as recorded", () => {
  const checkout = copyRepo();
  const real = entries.map((e) => ({ cmd: e.cmd, ...replay(e.cmd, checkout) }));

  if (process.env.UPDATE_DEMO_TRANSCRIPT) {
    fs.writeFileSync(TRANSCRIPT, JSON.stringify(real, null, 2) + "\n");
    return;
  }

  real.forEach((got, i) => {
    const want = entries[i];
    assert.equal(got.out, want.out, `entry ${i + 1} (${want.cmd}) printed different output`);
    assert.equal(got.status, want.status, `entry ${i + 1} (${want.cmd}) exited ${got.status}, transcript says ${want.status}`);
  });
});

const unescapeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// Session rows only: the one <text> carrying its own font-size is the title
// in the window chrome, not something a command printed.
function pictureRows(svg) {
  const rows = [];
  for (const m of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    if (/font-size=/.test(m[1])) continue;
    const inner = m[2].replace(/<tspan class="p"[^>]*>\$<\/tspan>/, "");
    rows.push(unescapeXml(inner.replace(/<[^>]+>/g, "")));
  }
  return rows;
}

test("every row of demo/terminal.svg traces back to the transcript", () => {
  const rows = pictureRows(fs.readFileSync(PICTURE, "utf8"));
  assert.ok(rows.length > 0, "found no text rows in the picture");

  const outLines = entries.flatMap((e) => e.out.split("\n"));
  const cmds = entries.map((e) => e.cmd);

  for (const row of rows) {
    // One trailing ellipsis means the renderer clipped the line. A wrapped
    // command row ends in " \" and its continuation is indented four spaces.
    const text = row.replace(/…$/, "").replace(/ \\$/, "").replace(/^ {4}/, "");
    if (!text.trim()) continue;
    const fromOutput = outLines.some((line) => line.startsWith(text));
    const fromCommand = cmds.some((cmd) => cmd.includes(text));
    assert.ok(fromOutput || fromCommand, `picture row is in no transcript entry: ${JSON.stringify(row)}`);
  }
});
