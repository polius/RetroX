// ESLint flat config for RetroX's vanilla-JS frontend.
//
// Intentionally lenient on day one — it catches real errors (syntax
// mistakes, undefined identifiers, unreachable code) without surfacing
// nitpicks the codebase isn't already enforcing. Tighten over time as
// you find specific rules pulling weight.

import js from "@eslint/js";
import globals from "globals";

export default [
  // Skip third-party vendored code — it's not ours to fix and its
  // style (var redeclarations, UMD wrappers, etc.) reflects the
  // library's conventions rather than ours.
  {
    ignores: ["js/vendor/**"],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // Underscore-prefixed args/vars are an existing convention in the
      // codebase for "intentionally unused" — respect it instead of
      // forcing every signature to be drained.
      "no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
      // Empty catches are used in poll loops to swallow transient
      // network blips without noise (see api.js, save-persistor.js).
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // Object/array prototype calls are common and safe in this code.
      "no-prototype-builtins": "off",
    },
  },
];
