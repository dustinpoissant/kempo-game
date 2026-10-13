/*
  Loaded with `--import` by scripts/run-tests.js in the unit tier, before any test file.

  The in-memory database is created on first import of the database module. Creating it here, in a
  clean process, keeps the run from depending on which suite imports it first or on globals a test
  file has installed by then.

  Only the test framework's own process boots it. NODE_OPTIONS is inherited by every node process,
  including `npx` in front of the framework and the children a test spawns (`node --check` per
  module, for example), and none of those should each build a database.
*/
/*
  The framework is `node_modules/.bin/kempo-test` on Linux and macOS (argv[1] is that symlink, not the
  real file) and `...\kempo-testing-framework\index.js` through the .cmd shim on Windows.
*/
const insideFramework = /kempo-test(ing-framework)?/.test(process.argv[1] || '');

if(process.env.KEMPO_DB === 'pglite' && insideFramework){
  await import('kempo/server/db/index.js');
}
