module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  // firestore.rules.test.ts needs a running Firestore emulator; run it via
  // `npm run test:rules` (firebase emulators:exec), not plain `npm test`.
  testPathIgnorePatterns: ['/node_modules/', 'firestore\\.rules\\.test\\.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/index.ts',
  ],
  coverageDirectory: 'coverage',
  verbose: true,
};