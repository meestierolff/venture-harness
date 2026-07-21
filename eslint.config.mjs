import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      ".agents/**",
      ".claude/skills/**",
      "examples/**",
      "coverage/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Direct gtag calls bypass the typed analytics abstraction and its
      // PII/consent guarantees. Use lib/analytics/track.ts instead.
      "no-restricted-globals": [
        "error",
        { name: "gtag", message: "Use lib/analytics/track.ts — never call gtag directly." },
      ],
    },
  },
];

export default eslintConfig;
