import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

// Shared across every environment: an unused `catch (e)` binding is idiomatic here,
// and `_`-prefixed params are an explicit "intentionally unused" marker.
const noUnusedVars = ['error', {
  args: 'after-used',
  argsIgnorePattern: '^_',
  caughtErrors: 'none',
  ignoreRestSiblings: true,
}]

export default defineConfig([
  // scratch/ is gitignored throwaway work; dist/ is build output.
  globalIgnores(['dist', 'dist-ssr', 'scratch', '**/node_modules']),

  // Browser app code — ESM + JSX + React rules.
  {
    files: ['src/**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: { 'no-unused-vars': noUnusedVars },
  },

  // Node ESM — root-level test/check scripts, maintenance scripts, and tool configs.
  // These run under `npx tsx` / `node`, not in the browser.
  {
    files: ['*.js', 'scripts/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: { 'no-unused-vars': noUnusedVars },
  },

  // Node CommonJS — Cloud Functions (functions/package.json has no "type" field)
  // and any explicit .cjs file.
  {
    files: ['functions/**/*.js', '**/*.cjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: { 'no-unused-vars': noUnusedVars },
  },
])
