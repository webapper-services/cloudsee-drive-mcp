// The version is substituted by esbuild at build time, so nothing is read from
// disk at runtime. The Lambda deploy package is a lone lambda.mjs with no
// package.json beside it; doing this lookup at load time crashed init and made
// every request return 502 on production (CSD-628).
//
// Every bundler entry point MUST declare the define. Three configs do:
//   server/tsup.config.ts        -> npm package (dist/index.js, dist/http.js)
//   infra/tsup.lambda.config.ts  -> Lambda bundle (infra/build/lambda/lambda.mjs)
//   server/vitest.config.ts      -> unit tests, which run the TS sources directly
// All three read the value from server/scripts/package-version.mjs.
//
// A new entry point that forgets the define throws ReferenceError at load. That
// is deliberate: fail loudly at startup rather than advertise a wrong version,
// which is what a `process.env` fallback would have done silently.
declare const __MCP_SERVER_VERSION__: string;

// The explicit `: string` keeps the ambient identifier out of dist/*.d.ts, which
// tsup emits because tsup.config.ts sets `dts: true`.
export const VERSION: string = __MCP_SERVER_VERSION__;
