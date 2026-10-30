import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const babel = require("/usr/share/nodejs/@babel/core");
const presetTs = require("/usr/share/nodejs/@babel/preset-typescript");
const presetReact = require("/usr/share/nodejs/@babel/preset-react");

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, "src");
const DIST_DIR = path.join(ROOT, "dist");

function collectFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function resolveImport(fromFile, spec) {
  let base;
  if (spec.startsWith("@/")) {
    base = path.join(SRC_DIR, spec.slice(2));
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else {
    return true;
  }
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) {
      return base + ext;
    }
  }
  return null;
}

const files = collectFiles(SRC_DIR);
let errors = 0;
const compiledMap = new Map();

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, "utf8");
  try {
    const res = babel.transformSync(src, {
      filename: file,
      configFile: false,
      babelrc: false,
      presets: [
        [presetTs, { isTSX: file.endsWith(".tsx"), allExtensions: true }],
        [presetReact, { runtime: "automatic" }],
      ],
      ast: true,
    });
    compiledMap.set(rel, res.code);

    for (const node of res.ast.program.body) {
      if (
        (node.type === "ImportDeclaration" ||
          node.type === "ExportNamedDeclaration" ||
          node.type === "ExportAllDeclaration") &&
        node.source
      ) {
        const target = resolveImport(file, node.source.value);
        if (!target) {
          console.error(`[ERROR] Unresolved import "${node.source.value}" in ${rel}`);
          errors++;
        }
      }
    }
  } catch (err) {
    console.error(`[ERROR] Failed to compile ${rel}: ${err.message}`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`Typecheck/build failed with ${errors} error(s).`);
  process.exit(1);
}

if (process.argv.includes("--build")) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST_DIR, "assets"), { recursive: true });
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(SRC_DIR, "index.css"), "utf8");
  const bundleJs = Array.from(compiledMap.entries())
    .map(([file, code]) => `// --- ${file} ---\n${code}`)
    .join("\n\n");
  fs.writeFileSync(path.join(DIST_DIR, "index.html"), html, "utf8");
  fs.writeFileSync(path.join(DIST_DIR, "assets", "index.css"), css, "utf8");
  fs.writeFileSync(path.join(DIST_DIR, "assets", "index.js"), bundleJs, "utf8");
  console.log(`[BUILD] Compiled ${files.length} TS/TSX modules -> dist/assets/index.js (${(bundleJs.length / 1024).toFixed(1)} kB) & dist/assets/index.css (${(css.length / 1024).toFixed(1)} kB)`);
} else {
  console.log(`[TYPECHECK] Checked ${files.length} TS/TSX files with 0 errors.`);
}
