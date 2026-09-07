module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
    jest: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  ignorePatterns: [
    'lib/**',
    'coverage/**',
  ],
  rules: {
    // TypeScript's compiler performs the project's unused-symbol checks.
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
    // The test suite uses require() for isolated Firebase mock setup.
    '@typescript-eslint/no-var-requires': 'off',
    // Existing regex/string escapes are intentional and kept readable.
    'no-useless-escape': 'off',
    // Existing tests use nested non-null assertions with optional chaining.
    '@typescript-eslint/no-extra-non-null-assertion': 'off',
    // Existing service boundaries use `any` for Express/Firebase adapter types.
    '@typescript-eslint/no-explicit-any': 'off',
  },
};
