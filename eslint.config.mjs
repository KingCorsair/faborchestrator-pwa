import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Mirrors `claudeai_athena/eslint.config.mjs`, but disables one rule rather
 * than five.
 *
 * `react-hooks/set-state-in-effect` is a React Compiler advisory that Next 16's
 * core-web-vitals promotes to an error. It fires on two patterns here and both
 * are deliberate:
 *
 *  - The copied console kit (`console-shell`, `session-banner`,
 *    `use-console-prefs`) reads localStorage and starts countdown timers in
 *    effects, because doing either during render is what causes a hydration
 *    mismatch. Those files are verbatim copies and must not be edited locally.
 *  - The two order pages set a load state at the top of a fetch effect. Without
 *    a query library — and the product deliberately has none — there is nowhere
 *    else for it to go.
 *
 * The other four rules the product disables are left ON: nothing here trips
 * them, and turning off a rule that is not firing only hides the next mistake.
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Honor the "_"-prefix convention for intentionally-unused bindings.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // Server code logs through `lib/report-error.ts` only (plan RP10-A part 2):
    // one JSON shape, paths masked, never a token, an FO URL or a full id. A
    // raw `console.*` is how the URL-bearing lines got in before, so it is an
    // error here rather than a convention. Client components are not server
    // logs and are not covered.
    files: ["app/**/*.{ts,tsx}", "lib/**/*.ts", "proxy.ts"],
    ignores: ["lib/report-error.ts"],
    rules: { "no-console": "error" },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
