module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  // Emulator-required suites run only via `npm run test:rules` or
  // `npm run test:datastore`, each with its own ephemeral localhost emulator.
  testPathIgnorePatterns: ['/node_modules/', 'firestore\\.rules\\.test\\.ts', '\\.integration\\.test\\.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/index.ts',
  ],
  coverageDirectory: 'coverage',
  verbose: true,
};