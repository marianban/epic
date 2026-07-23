import js from '@eslint/js'
import prettierConfig from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '.agent/**',
      '.agents/**',
      '.codex/**',
      'coverage/**',
      'dist/**',
      'node_modules/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    files: ['**/*.{ts,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {},
      globals: {
        ...globals.nodeBuiltin,
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {},
  },
  prettierConfig
)
