/**
 * Minimal Jest transformer for the mobile unit tests: TypeScript
 * transpile-only via the workspace's own typescript package.
 *
 * Why not ts-jest / jest-expo: the suites here cover PURE logic
 * (formatting, candidate chains, timing math) — no components, no
 * native modules — so the full RN preset is weight without
 * benefit, and ts-jest's peer range predates the app's
 * TypeScript 6. Transpile-only (like the API's isolatedModules
 * mode) keeps the runner honest and fast; type safety stays
 * enforced by `npm run typecheck:mobile`, which covers the test
 * files too.
 */
const ts = require('typescript');

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(sourceText, {
      fileName: sourcePath,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2021,
        esModuleInterop: true,
        jsx: ts.JsxEmit.React,
      },
    });
    return { code: outputText };
  },
};
