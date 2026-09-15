/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
  env: {
    node: true,
    es2022: true,
  },
  plugins: ["@typescript-eslint", "react", "react-hooks"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react/recommended",
    "plugin:react-hooks/recommended",
  ],
  settings: {
    react: { version: "detect" },
  },
  ignorePatterns: ["build/", "node_modules/", ".cache/", "prisma/migrations/"],
  rules: {
    // The money and rounding modules are the single centralized place
    // rounding is allowed to happen (spec §0.4). This rule is the
    // repository-wide, automated backstop for acceptance criterion 6:
    // "no ad-hoc Math.round on monetary values" anywhere else.
    "no-restricted-syntax": [
      "error",
      {
        selector:
          "CallExpression[callee.object.name='Math'][callee.property.name=/^(round|floor|ceil)$/]",
        message:
          "Do not call Math.round/floor/ceil directly. Money rounding must go through the versioned rule registry in app/domain/money/rounding.ts.",
      },
    ],
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
    ],
    "react/react-in-jsx-scope": "off",
    "react/prop-types": "off",
    // Application logging must go through the structured logger
    // (spec §0.2), which redacts sensitive keys. app/lib/logger.server.ts
    // is the one place console is reached directly, via explicit disables.
    "no-console": "error",
  },
  overrides: [
    {
      files: ["**/*.test.ts", "**/*.test.tsx"],
      rules: {
        "@typescript-eslint/no-explicit-any": "off",
      },
    },
    {
      // Standalone CLI entry points and the Remix server entry are not
      // request-scoped business logging; console is their correct output.
      files: ["scripts/**/*.mjs", "prisma/seed.ts", "app/entry.server.tsx"],
      rules: {
        "no-console": "off",
      },
    },
  ],
};
