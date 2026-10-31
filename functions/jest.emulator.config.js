module.exports = {
  ...require('./jest.config'),
  testPathIgnorePatterns: ['/node_modules/'],
  // Emulator SDK calls and transaction retries can exceed Jest's 5s default.
  testTimeout: 30_000,
};
