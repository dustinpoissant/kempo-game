/*
  Loaded with `--import` by scripts/run-tests.js in the unit tier, before any test file.

  The in-memory database is created on first import of kempo's database module. Creating it here, in a
  clean process, keeps the run from depending on which suite imports it first or on globals a test
  file has installed by then.
*/
if(process.env.KEMPO_DB === 'pglite'){
  await import('kempo/server/db/index.js');
}
