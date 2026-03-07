import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.vite/**",
      "**/.minimax/**",
      "**/.trae/**",
      "data/**",
      "logs/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["dashboard-v2/src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "off"
    }
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    rules: {
      "no-undef": "off",
      "no-empty": "off",
      "no-constant-binary-expression": "off",
      "no-case-declarations": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
      "prefer-const": "off",
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unused-expressions": "off"
    }
  },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    rules: {
      "no-empty": "off",
      "no-case-declarations": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
      "prefer-const": "off",
      "no-console": "off",
      "@typescript-eslint/no-unused-vars": "off"
    }
  },
  eslintConfigPrettier
];
