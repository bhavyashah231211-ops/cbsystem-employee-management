import { build } from "esbuild";
await build({
  entryPoints: ["/mnt/user-data/outputs/holiday/supabase/functions/cbs-hol/index.ts"],
  bundle: true, format: "esm", platform: "node", outfile: "/tmp/e2e/fn-test.mjs", logLevel: "warning",
  plugins: [{ name: "npm-alias", setup(b) {
    b.onResolve({ filter: /^npm:@supabase\/supabase-js@2$/ }, () => ({ path: "/tmp/e2e/node_modules/@supabase/supabase-js/dist/index.mjs" }));
  }}],
});
