import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Mirrors `claudeai_athena/eslint.config.mjs`, but disables one rule rather
 * than five.
 *
 * `react-hooks/set-state-in-effect` is a React Compiler advisory that Next 16's
 * core-web-vitals promotes to an error. It fires on two patterns here and both
 * are deliberate (checked 2026-09-28 by running the rule — eight files):
 *
 *  - Reading what only the browser knows — `localStorage`, the user agent, the
 *    idle clock — and starting timers, in effects: the sign-in page, the
 *    sign-out link, the iOS install hint, `/diagnostics`, the top bar's
 *    countdowns, the crash screen's reference. Doing any of it during render is
 *    what causes a hydration mismatch.
 *  - Setting a loading state at the top of a fetch effect — the conversation
 *    screen and the drawer. Without a query library — and the product
 *    deliberately has none — there is nowhere else for it to go.
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
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
