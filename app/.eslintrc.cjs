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
  ignorePatterns: ["build/", "node_modules/", ".cache/", ".react-router/", "prisma/migrations/"],
  rules: {
    // The money and rounding modules are the single centralized place
    // rounding is allowed to happen (spec §0.4). This rule is the
    // repository-wide, automated backstop for acceptance criterion 6:
    // "no ad-hoc Math.round on monetary values" anywhere else.
    //
    // Two selectors are required (Slice 0 finding F-1 / Slice 1 spec §8.1).
    // A `CallExpression[callee.object.name='Math']`-only selector (the
    // original form) matches a literal, non-computed call, `Math.round(x)`,
    // but does NOT match computed member access (`Math["round"](x)`) or a
    // reference that is aliased instead of called (`const r = Math.round`;
    // later `r(x)`) — both still resolve to `Math.round` at runtime but are
    // syntactically a bare `MemberExpression`, not that `CallExpression`
    // shape. Matching on `MemberExpression` directly (below) closes that
    // gap and also subsumes the plain-call case, since a call's `callee` is
    // itself a `MemberExpression` node that gets visited independently — so
    // a single `CallExpression`-shaped selector is no longer needed.
    //
    // Scoped to round/floor/ceil/trunc (not a bare
    // `MemberExpression[object.name='Math']`, which the source spec's
    // prose literally suggests): an unscoped selector would also flag
    // Math.random/abs/min/max/PI/sqrt, which have nothing to do with money
    // rounding and are used elsewhere in the suite (e.g.
    // executeIdempotent.test.ts's `Math.random()`). Flag this scoping
    // choice for architect confirmation in the handoff — it preserves the
    // spec's intent (catch computed/aliased rounding access) without
    // banning unrelated Math usage repository-wide.
    //
    // Two property shapes are needed because computed access
    // (`Math["round"]`) puts the method name on `property.value` (a
    // `Literal`), while normal dot access (`Math.round`) puts it on
    // `property.name` (an `Identifier`) — a single attribute selector
    // cannot match both.
    "no-restricted-syntax": [
      "error",
      {
        selector:
          "MemberExpression[object.name='Math'][property.name=/^(round|floor|ceil|trunc)$/]",
        message:
          "Do not reference Math.round/floor/ceil/trunc directly, whether called or aliased (e.g. `const r = Math.round`). Money rounding must go through the versioned rule registry in app/domain/money/rounding.ts.",
      },
      {
        selector:
          "MemberExpression[object.name='Math'][computed=true][property.value=/^(round|floor|ceil|trunc)$/]",
        message:
          "Do not access Math via computed member expression (e.g. Math[\"round\"]) to reach round/floor/ceil/trunc. Money rounding must go through the versioned rule registry in app/domain/money/rounding.ts.",
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
      // Standalone CLI entry points, the test bootstrap and the React Router
      // server entry are not request-scoped business logging; console is their
      // correct output. globalSetup runs before any test and reports why it is
      // pausing to build the server bundle — that belongs on stdout, not in the
      // redacting structured logger.
      files: [
        "scripts/**/*.mjs",
        "prisma/seed.ts",
        "app/entry.server.tsx",
        "tests/integration/globalSetup.ts",
      ],
      rules: {
        "no-console": "off",
      },
    },
  ],
};
