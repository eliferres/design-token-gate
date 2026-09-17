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
// in the window chrome, not something a command printed. A command row holds
// the prompt tspan, a wrapped command continues on a row of its own indented
// four spaces, and everything else is output.
function pictureRows(svg) {
  const rows = [];
  for (const m of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    if (/font-size=/.test(m[1])) continue;
    const prompted = /<tspan class="p"[^>]*>\$<\/tspan>/.test(m[2]);
    const text = unescapeXml(m[2].replace(/<tspan class="p"[^>]*>\$<\/tspan>/, "").replace(/<[^>]+>/g, ""));
    if (prompted) rows.push({ kind: "cmd", text });
    else if (/class="cmd"/.test(m[1])) rows.push({ kind: "cont", text: text.replace(/^ {4}/, "") });
    else rows.push({ kind: "out", text });
  }
  return rows;
}

// Undo the drawing's wrapping instead of re-deriving where it falls: a wrapped
// row ends in " \" and the chunks rejoin with the one space the break ate.
const rejoin = (chunks) => chunks.map((c) => (c.endsWith(" \\") ? c.slice(0, -2) : c)).join(" ");

const shownWhole = (row, line) =>
  row === line ||
  (row.endsWith("…") && row.split("…").length === 2 && line.startsWith(row.slice(0, -1)) && row.length - 1 < line.length);

test("the picture shows whole entries, with no row missing, added or reordered", () => {
  const rows = pictureRows(fs.readFileSync(PICTURE, "utf8"));
  assert.ok(rows.length > 0, "found no text rows in the picture");

  let i = 0;
  for (const entry of entries) {
    if (i === rows.length) break; // the picture holds whole entries, then stops
    assert.equal(rows[i].kind, "cmd", `row ${i + 1} should start the command ${entry.cmd}`);
    const chunks = [rows[i].text];
    i += 1;
    while (i < rows.length && rows[i].kind === "cont") chunks.push(rows[i++].text);
    assert.equal(rejoin(chunks), entry.cmd, `rows ${i} of the picture do not rebuild the command`);

    for (const line of entry.out.split("\n").filter((l) => l.trim())) {
      assert.ok(i < rows.length, `the picture stops inside ${entry.cmd}, before its line ${JSON.stringify(line)}`);
      assert.equal(rows[i].kind, "out", `row ${i + 1} should be the output line ${JSON.stringify(line)}`);
      assert.ok(shownWhole(rows[i].text, line),
        `row ${i + 1} is ${JSON.stringify(rows[i].text)}, expected ${JSON.stringify(line)} whole or end-trimmed with one ellipsis`);
      i += 1;
    }
  }
  assert.equal(i, rows.length, `the picture draws ${rows.length - i} row(s) the transcript does not account for`);
});
