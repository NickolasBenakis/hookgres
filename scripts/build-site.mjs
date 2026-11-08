// Builds the deployable hookgres.dev site into .site-dist/:
//   /         the static landing page from site/
//   /docs/    the VitePress docs from docs/
// Deployed on Vercel; see vercel.json (build command and output directory).
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = join(root, ".site-dist");

rmSync(out, { recursive: true, force: true });
execFileSync("pnpm", ["exec", "vitepress", "build", "docs"], {
  cwd: root,
  stdio: "inherit",
});
cpSync(join(root, "site"), out, { recursive: true });
cpSync(join(root, "docs/.vitepress/dist"), join(out, "docs"), {
  recursive: true,
});

// Point crawlers at the docs sitemap as well as the landing page's.
const robots = join(out, "robots.txt");
const docsSitemap = "Sitemap: https://hookgres.dev/docs/sitemap.xml";
if (existsSync(robots) && !readFileSync(robots, "utf8").includes(docsSitemap)) {
  writeFileSync(
    robots,
    `${readFileSync(robots, "utf8").trimEnd()}\n${docsSitemap}\n`,
  );
}
console.log(`Site built in ${out}`);
