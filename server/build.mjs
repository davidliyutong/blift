// Bundles the Node (Docker) entry into a single ESM file: dist/server.mjs.
// The Workers bundle is produced by wrangler itself (`wrangler deploy`).
import { build } from "esbuild";

await build({
  entryPoints: ["src/node.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  minify: false,
  // Some deps still call require() for node builtins; give ESM output a require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
