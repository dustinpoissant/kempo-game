import { cp, rm, symlink, lstat, mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { sql, eq, like } from 'drizzle-orm';
import { db, schema, installExtension, uninstallExtension, createUser, addUserToGroup, createHook, clearHandlerCache } from 'kempo/server/sdk.js';
import { kempoGame, kempoGamePlayer } from '../../server/db/schema.js';
import { invalidateScopeCache } from 'kempo/server/utils/extensions/scopeCache.js';
import { clearModuleCache } from '../../server/utils/types/types.js';
import getManager from '../../server/utils/live/getManager.js';

/*
  What every suite that needs a real kempo needs: kempo-game and a test game installed the way a site
  installs an extension (through kempo's own installExtension, so the declared permissions, groups,
  settings, hooks and tables are the ones a real install would create), and some users.

  It refuses to run against a database whose name does not end in `_test`. These helpers delete every
  game and every test user, and the memory of the repos this lives beside includes a suite emptying a
  real demo database because nothing stopped it.
*/

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const GAME_EXTENSION = 'kempo-game';
export const FIXTURE = 'kempo-game-test-click-race';
export const PASSWORD = 'GameTest123!';

const nodeModules = path.join(root, 'node_modules');
const fixtureTarget = path.join(nodeModules, FIXTURE);
const selfLink = path.join(nodeModules, GAME_EXTENSION);

const databaseName = (process.env.DATABASE_URL || '').split('/').pop().split('?')[0];

export const databaseReachable = /_test$/.test(databaseName)
  && await db.execute(sql`select 1`).then(() => true).catch(() => false);

export const skipReason = () => (
  /_test$/.test(databaseName)
    ? 'no reachable database, set DATABASE_URL to a Postgres with kempo\'s and this extension\'s schema applied (npx drizzle-kit push)'
    : `DATABASE_URL must name a database ending in _test (got "${databaseName}"): these suites delete every game and every test user`
);

export const skipped = name => ({
  [`${name} (SKIPPED)`]: async ({ pass }) => pass(`skipped: ${skipReason()}`),
});

const exists = async target => lstat(target).then(() => true).catch(() => false);

/*
  The extension has to live at node_modules/kempo-game for kempo to find its hooks and its public
  routes, as it does on a site. In this repo that is a link back to the checkout.
*/
const link = async () => {
  if(await exists(selfLink)) await rm(selfLink, { recursive: true, force: true });
  await symlink(root, selfLink, 'junction');
};

export const purgeData = async () => {
  await getManager().shutdown().catch(() => {});
  await db.delete(kempoGamePlayer).catch(() => {});
  await db.delete(kempoGame).catch(() => {});

  const users = await db.select().from(schema.user).where(like(schema.user.email, 'game-test-%@test.local'));
  for(const row of users){
    await db.delete(schema.session).where(eq(schema.session.userId, row.id)).catch(() => {});
    await db.delete(schema.userGroup).where(eq(schema.userGroup.userId, row.id)).catch(() => {});
    await db.delete(schema.user).where(eq(schema.user.id, row.id)).catch(() => {});
  }
};

export const uninstall = async () => {
  await purgeData();
  for(const name of [FIXTURE, GAME_EXTENSION]){
    await uninstallExtension({ name, purgeData: true }).catch(() => {});
  }
  await rm(fixtureTarget, { recursive: true, force: true }).catch(() => {});
  await rm(selfLink, { recursive: true, force: true }).catch(() => {});
  clearHandlerCache();
  clearModuleCache();
  invalidateScopeCache();
};

export const install = async () => {
  await uninstall();
  await mkdir(nodeModules, { recursive: true });
  await link();
  await cp(path.join(root, 'tests', 'fixtures', 'click-race'), fixtureTarget, { recursive: true });

  for(const name of [GAME_EXTENSION, FIXTURE]){
    const [error] = await installExtension({ name });
    if(error) throw new Error(`could not install ${name}: ${error.msg}`);
  }
  clearModuleCache();
  invalidateScopeCache();
};

/*
  Users who can play. `label` keeps them recognisable and unique per suite.
*/
let counter = 0;

export const makeUser = async (label, { player = true } = {}) => {
  const email = `game-test-${label}-${Date.now()}-${++counter}@test.local`;
  const [error, created] = await createUser({ name: `Tester ${label}`, email, password: PASSWORD, emailVerified: true });
  if(error) throw new Error(`could not create ${label}: ${error.msg}`);

  const id = created.user?.id || created.id;
  if(player){
    const [groupError] = await addUserToGroup(id, 'kempo-game:player');
    if(groupError) throw new Error(`could not add ${label} to the player group: ${groupError.msg}`);
  }
  return { id, email, password: PASSWORD, name: `Tester ${label}` };
};

export const makeAdmin = async (label) => {
  const admin = await makeUser(label, { player: false });
  const [error] = await addUserToGroup(admin.id, 'kempo-game:administrator');
  if(error) throw new Error(`could not add ${label} to the administrator group: ${error.msg}`);
  return admin;
};

/*
  Real hooks, through kempo's hook system: a row in the hook table naming a handler file, exactly as an
  extension that reacts to games would register one. Each handler records what it was given, so a test
  sees what such an extension would receive. `refuse` makes a guard hook refuse one user with a
  { code, msg } (as a hook should), and `explode` makes it throw something it should not have.
*/
const HOOK_LOG = Symbol.for('kempo.game.test.hooks');
const HOOK_OWNER = 'kempo-game-test-hooks';
const hookDir = path.join(root, 'tests', '.tmp-hooks');

export const hookLog = () => globalThis[HOOK_LOG] || [];

export const removeHooks = async () => {
  await db.delete(schema.hook).where(eq(schema.hook.owner, HOOK_OWNER)).catch(() => {});
  clearHandlerCache();
  delete globalThis[HOOK_LOG];
  await rm(hookDir, { recursive: true, force: true }).catch(() => {});
};

/*
  A file is imported once and kept, so a handler rewritten at the same path would still run its old
  code. Each install writes to a fresh path.
*/
let hookRound = 0;

export const installHooks = async (events, { refuse, explode } = {}) => {
  await removeHooks();
  await mkdir(hookDir, { recursive: true });
  globalThis[HOOK_LOG] = [];
  hookRound++;

  for(const event of events){
    const file = path.join(hookDir, `${hookRound}-${event.replace(/[^a-z_]/g, '-')}.js`);
    const lines = [];
    if(refuse) lines.push(`if([data.userId, data.gameId, data.actorId].includes(${JSON.stringify(refuse)})) throw { code: 451, msg: 'Not today' };`);
    if(explode) lines.push(`if(data.userId === ${JSON.stringify(explode)}) throw new Error('secret internal detail');`);
    lines.push(`(globalThis[Symbol.for('kempo.game.test.hooks')] ||= []).push({ event: ${JSON.stringify(event)}, ...data });`);
    await writeFile(file, ['export default async (data) => {', ...lines.map(line => '  ' + line), '};', ''].join(String.fromCharCode(10)));

    const [error] = await createHook({ owner: HOOK_OWNER, event, callback: file });
    if(error) throw new Error(`could not create the ${event} hook: ${error.msg}`);
  }
};

export const expect = (condition, message) => {
  if(!condition) throw new Error(message);
};

export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export const until = async (condition, description, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while(Date.now() < deadline){
    if(await condition()) return;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${description}`);
};

export { db, kempoGame, kempoGamePlayer };
