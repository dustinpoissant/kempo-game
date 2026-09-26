import { readFile, readdir, access } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULTS } from '../server/utils/config/settings.js';

/*
  Static checks that what the code asks for is what the extension declares.

  A permission check against a name nobody registered does not error: it answers no, forever, and only
  for people who are not administrators, which is why that kind of bug survives manual testing. And a
  hook file that is declared but missing would make kempo fail to import it on every event.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'kempo-config.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const expect = (condition, message) => {
  if(!condition) throw new Error(message);
};

const walk = async (dir) => {
  const files = [];
  for(const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])){
    if(entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if(entry.isDirectory()) files.push(...await walk(full));
    else if(entry.name.endsWith('.js')) files.push(full);
  }
  return files;
};

const exists = target => access(target).then(() => true, () => false);

const sources = [];
for(const dir of ['server', 'public', 'hooks', 'admin']) sources.push(...await walk(path.join(root, dir)));
sources.push(path.join(root, 'sdk.js'));
const texts = new Map();
for(const file of sources) texts.set(file, await readFile(file, 'utf8'));

export default {
  'every permission the code checks is one the extension declares, and every declared one is checked': async ({ pass }) => {
    const declared = new Set(config.permissions.map(permission => permission.name));
    const used = new Set();
    for(const text of texts.values()){
      for(const match of text.matchAll(/['"`](game:[a-z_:]+)['"`]/g)){
        // Hook events share the prefix; they are never checked as permissions
        if(/game:(created|deleted|player_|started|ended|saved|before_|ownership_)/.test(match[1])) continue;
        used.add(match[1]);
      }
    }

    for(const name of used) expect(declared.has(name), `the code checks "${name}" but kempo-config.json does not declare it`);
    for(const name of declared) expect(used.has(name), `"${name}" is declared but nothing checks it`);
    pass('permissions');
  },

  'every group grants only declared permissions, and the player group is the gate': async ({ pass }) => {
    const declared = new Set(config.permissions.map(permission => permission.name));
    for(const group of config.groups){
      for(const name of group.permissions) expect(declared.has(name), `${group.name} grants "${name}", which is not declared`);
    }
    const players = config.groups.find(group => group.name === 'kempo-game:player');
    expect(players && players.permissions.join() === 'game:play', 'kempo-game:player grants exactly game:play');
    const admins = config.groups.find(group => group.name === 'kempo-game:administrator');
    expect(admins.permissions.includes('game:admin') && admins.permissions.includes('game:play'), 'administrators can play and administer');
    pass('groups');
  },

  'every declared hook is a file that exists and exports a function': async ({ pass }) => {
    for(const [event, callback] of Object.entries(config.hooks)){
      expect(callback.startsWith('./'), `${event} should be a path inside the package`);
      const file = path.join(root, callback);
      expect(await exists(file), `${event} names ${callback}, which does not exist`);
      const loaded = await import(`file:///${file.replace(/\\/g, '/')}`);
      expect(typeof loaded.default === 'function', `${callback} should export a function`);
    }
    expect(config.hooks['realtime:subscribed'] && config.hooks['realtime:unsubscribed'], 'presence needs both realtime hooks');
    pass('hooks');
  },

  'the settings defaults in code are the ones the extension declares': async ({ pass }) => {
    const byName = Object.fromEntries(config.settings.map(setting => [setting.name, setting]));
    const pairs = { autosave_seconds: 'autosaveSeconds', idle_seconds: 'idleSeconds', max_state_bytes: 'maxStateBytes', max_settings_bytes: 'maxSettingsBytes', max_games_per_user: 'maxGamesPerUser' };
    for(const [name, key] of Object.entries(pairs)){
      expect(byName[name], `${name} should be declared`);
      expect(byName[name].type === 'number' && Number(byName[name].value) === DEFAULTS[key], `${name} is declared as ${byName[name].value} but the fallback in code is ${DEFAULTS[key]}`);
    }
    expect(Object.keys(byName).length === Object.keys(pairs).length, 'nothing is declared that the code does not read');
    pass('settings');
  },

  'the package publishes what it needs and names its entry points': async ({ pass }) => {
    for(const entry of ['install.js', 'update.js', 'uninstall.js', 'sdk.js', 'kempo-config.json']){
      expect(pkg.files.includes(entry) && await exists(path.join(root, entry)), `${entry} should exist and be published`);
    }
    for(const dir of ['admin', 'hooks', 'public', 'server']) expect(pkg.files.includes(dir), `${dir} should be published`);
    expect(pkg.files.includes('!server/db/migrations'), 'test-database migrations are never published');
    expect(!pkg.files.some(entry => entry.startsWith('tests')), 'tests are not published');
    expect(pkg.exports['./sdk'] === './sdk.js' && pkg.main === 'sdk.js', 'the SDK is the main entry');
    expect(pkg.kempo['public-scope'] === config['public-scope'] && config['public-scope'] === 'game', 'the public scope is game, and both files agree');
    expect(config.schema === './server/db/schema.js' && await exists(path.join(root, 'server/db/schema.js')), 'the schema is declared');
    pass('package');
  },

  'nothing on the server side imports from the browser folder except the shared change format': async ({ pass }) => {
    for(const [file, text] of texts){
      if(!file.includes(`${path.sep}server${path.sep}`) && !file.endsWith('sdk.js')) continue;
      for(const match of text.matchAll(/from\s+['"]([^'"]*public\/[^'"]+)['"]/g)){
        expect(/public\/utils\/changes\.js$/.test(match[1]), `${path.relative(root, file)} imports ${match[1]}`);
      }
    }
    pass('layers');
  },

  'the browser files import the server-independent modules by absolute URL or by relative path, never a bare package': async ({ pass }) => {
    for(const [file, text] of texts){
      if(!file.includes(`${path.sep}public${path.sep}`) || file.includes(`${path.sep}api${path.sep}`)) continue;
      for(const match of text.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)){
        expect(match[1].startsWith('/') || match[1].startsWith('./') || match[1].startsWith('../'), `${path.relative(root, file)} imports a bare specifier "${match[1]}", which a browser cannot resolve`);
      }
    }
    pass('browser imports');
  }
};
