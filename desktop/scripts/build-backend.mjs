// Converts ../src/*.ts into plain JavaScript in ./backend so the backend runs on
// Electron's bundled Node (which can't run TypeScript). Uses Node's built-in type
// stripper, so it needs Node >= 22.13 on the build machine - not on users' machines.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..", "..", "src");
const outDir = path.resolve(here, "..", "backend");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let count = 0;
for (const name of readdirSync(srcDir)) {
  if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
  const source = readFileSync(path.join(srcDir, name), "utf8");
  const js = stripTypeScriptTypes(source, { mode: "strip" })
    // Relative imports point at .ts files in the source; point them at the .js output.
    .replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2")
    .replace(/(import\(\s*["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2");
  writeFileSync(path.join(outDir, name.replace(/\.ts$/, ".js")), js);
  count++;
}
writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");
console.log(`build-backend: wrote ${count} files to ${path.relative(process.cwd(), outDir) || outDir}`);
