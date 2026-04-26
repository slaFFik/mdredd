import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import reactCompiler from 'eslint-plugin-react-compiler';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.vite/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    ...reactHooks.configs.flat['recommended-latest'],
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    plugins: {
      'react-refresh': reactRefresh,
      'react-compiler': reactCompiler,
    },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'react-compiler/react-compiler': 'error',
    },
  },
  {
    files: ['src/server/**/*.ts', 'src/shared/**/*.ts', 'bin/**/*.{js,mjs}', 'test/**/*.{ts,mjs}'],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
