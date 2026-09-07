// Firestore rules tests run under firebase emulators:exec. Unlike the
// default Jest config, this config does not ignore firestore.rules.test.ts.
module.exports = {
  ...require('./jest.config'),
  testPathIgnorePatterns: ['/node_modules/'],
};
