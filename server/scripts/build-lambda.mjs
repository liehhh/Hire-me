// Bundles the Lambda handler (and the AWS SDK clients it uses) into a single
// ES module at server/lambda-dist/index.mjs. `sam deploy` uploads that folder.
import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("lambda-dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/lambda/handler.ts"],
  outfile: "lambda-dist/index.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: true,
  // Some bundled CommonJS dependencies call require() / use __dirname.
  banner: {
    js: [
      'import { createRequire as __cr } from "node:module";',
      'import { fileURLToPath as __fu } from "node:url";',
      'import { dirname as __dn } from "node:path";',
      "const require = __cr(import.meta.url);",
      "const __filename = __fu(import.meta.url);",
      "const __dirname = __dn(__filename);",
    ].join("\n"),
  },
  logLevel: "info",
});
