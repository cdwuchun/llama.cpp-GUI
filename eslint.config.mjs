/**
 * 轻量 ESLint 配置（审查 Q5）：仓库原来完全没有静态检查，这里只开「新代码容易踩、又不至于
 * 让历史代码整片变红」的几条警告级规则。`npm run lint` 永远 exit 0，先把问题晒出来；
 * 等历史告警清完再考虑升级成 error。
 */
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "src-tauri/**", "node_modules/**", "tmp/**", "scripts/**", ".npm-cache/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin, "react-hooks": reactHooks },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-dupe-keys": "warn",
      "no-unsafe-negation": "warn",
      "react-hooks/rules-of-hooks": "warn",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
