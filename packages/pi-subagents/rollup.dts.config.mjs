import { dts } from "rollup-plugin-dts";

// Roll all public type surfaces into self-contained declaration bundles.
// We ship .ts source, so we want only .d.ts — no JS emit.
// Internal #src/* modules are inlined; peer-dependency types are kept external.

const external = [/^@earendil-works\//, "@sinclair/typebox"];
const plugin = dts({ tsconfig: "./tsconfig.json" });

export default [
  // . entry: cross-extension service contract (spawn/abort/workspace seam)
  {
    input: "src/service/service.ts",
    output: { file: "dist/public.d.ts", format: "es" },
    external,
    plugins: [plugin],
  },
  // ./settings entry: generic layered config loader for @gotgenes/pi-* extensions
  {
    input: "src/layered-settings.ts",
    output: { file: "dist/settings.d.ts", format: "es" },
    external,
    plugins: [plugin],
  },
];
