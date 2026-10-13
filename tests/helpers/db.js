/*
  Shared by the database-backed suites. See scripts/run-tests.js for the tiers.
*/

export const unitTier = process.env.KEMPO_DB === 'pglite';
export const integrationTier = process.env.KEMPO_TEST_TIER === 'integration';

/*
  The suite for a file that belongs to the integration tier, reported as such in the unit tier. It is
  explicit rather than a silent skip, and `npm run test:integration` is where it runs.
*/
export const integrationOnly = name => ({
  [`${name} (integration tier)`]: async ({ pass }) => pass('runs in `npm run test:integration`: it needs a real Postgres or a second server process'),
});

/*
  Seeds kempo's system groups, permissions and settings in-process. Needs kempo >= 4.5.5.
*/
export const seedDatabase = async () => (await import('kempo/server/utils/setup/seedDatabase.js')).default({ log: () => {} });
