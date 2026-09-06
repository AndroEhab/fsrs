// ts-jest ESM preset (package.json has "type": "module").
// Mirrors functions/jest.config.js conventions (jest + ts-jest, node env).
// jose ships pure ESM; its JS files must be transformed by ts-jest's ESM
// pipeline, so it is allow-listed in transformIgnorePatterns below.
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.(ts|js)$': ['ts-jest', { useESM: true }],
  },
  transformIgnorePatterns: ['node_modules/(?!jose)'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  verbose: true,
};
