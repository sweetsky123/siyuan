const fs = require("fs");
const s = fs.readFileSync("app/src/config/tabs/syncUi.ts", "utf8");
const re = /genBilingualLabel\("([^"]*)", "([^"]*)"\)/g;
let m;
const bad = [];
const pairs = [];
while ((m = re.exec(s))) {
  pairs.push([m[1], m[2]]);
  if (
    m[1].includes("可 选") ||
    m[2].includes("可 选") ||
    m[1].includes("（") ||
    m[2].includes("（") ||
    m[1].includes("Skip)fy") ||
    m[1].includes("区域 I") ||
    /\s{2,}/.test(m[1]) ||
    /\s{2,}/.test(m[2]) ||
    m[2] !== m[2].trim() ||
    m[1] !== m[1].trim()
  ) {
    bad.push(m[0]);
  }
}
console.log("pair count", pairs.length);
console.log("bad labels", bad);
console.log(
  "secondaries",
  [...new Set(pairs.map((p) => p[1]))].join(" | ")
);
// also check option labels with fullwidth
const optionBad = [...s.matchAll(/label:\s*"([^"]+)"/g)]
  .map((x) => x[1])
  .filter((t) => t.includes("（") || t.includes("可 选") || t.includes("Skip)fy"));
console.log("option bad", optionBad);

// referer line exact
const lines = s.split(/\n/);
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('id: "referer"')) {
    console.log("referer line", i + 1, JSON.stringify(lines[i]));
  }
}
