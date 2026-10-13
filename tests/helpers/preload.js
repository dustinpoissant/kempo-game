/*
  Loaded with `--import` by scripts/run-tests.js in the unit tier, before any test file.

  The in-memory database is created on first import of the database module. Creating it here, in a
  clean process, keeps the run from depending on which suite imports it first or on globals a test
  file has installed by then.

  Only the main process gets it: the flag is removed from NODE_OPTIONS once loaded, so a test that
  spawns child processes (`node --check` per module, for example) does not boot a database in each.
*/
if(process.env.KEMPO_DB === 'pglite'){
  process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '').replace(/--import=\S*preload\.js/, '').trim();
  await import('kempo/server/db/index.js');
}
