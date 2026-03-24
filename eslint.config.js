import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  // Global ignores — must be a standalone config object with only `ignores`
  {
    ignores: ['node_modules/', 'dist/', 'dist-renderer/', '**/*.cjs'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Browser JS files (pre-React bootstrap layer: i18n, theme, platform)
  {
    files: ['desktop/src/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // Server-side JS files
  {
    files: ['server/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        fetch: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },

  // TypeScript/React frontend files
  {
    files: ['desktop/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // Prevent document.createElement in React components
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='document'][callee.property.name='createElement']",
          message:
            'React 组件中不要用 document.createElement，用 JSX。如确需操作 DOM（canvas/resize），加 eslint-disable 注释说明原因。',
        },
      ],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },

  // Downgrade noisy recommended rules to warnings (non-architectural, fix incrementally)
  {
    rules: {
      'no-empty': 'warn',
      'prefer-const': 'warn',
      'no-useless-escape': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },

  // Prevent engine._ access in server routes
  {
    files: ['server/routes/**/*.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='engine'][property.name=/^_/]",
          message: '不要访问 engine 的私有方法。通过 engine 公开 API 访问。',
        },
      ],
    },
  },
];
