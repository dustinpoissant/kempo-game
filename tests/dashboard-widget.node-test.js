import path from 'path';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { fileURLToPath, pathToFileURL } from 'url';

/*
  This extension adds widgets to the kempo admin dashboard through `widgets` in kempo-config.json. Core
  refuses a definition it could not render (and the extension would fail to install), and a module path
  that points at nothing only shows up as a broken tile, so both are checked here with core's own
  validation.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'kempo-config.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const { normalizeWidget } = await import(pathToFileURL(path.join(root, 'node_modules', 'kempo', 'server', 'utils', 'dashboard', 'helpers.js')).href);

const scope = `/${config['public-scope'] || pkg.kempo?.['public-scope']}/`;
const permissions = new Set((config.permissions || []).map(p => p.name));

export default {
  'kempo-config.json declares at least one widget': async ({ pass, fail }) => {
    if(!Array.isArray(config.widgets) || !config.widgets.length) return fail('no widgets declared');
    pass(`${config.widgets.length} widget(s)`);
  },

  'every declared widget passes core\'s validation': async ({ pass, fail }) => {
    for(const widget of config.widgets){
      const [error] = normalizeWidget({ ...widget, owner: pkg.name });
      if(error) return fail(`${widget.key}: ${error.msg}`);
    }
    pass();
  },

  'every widget module is served from the public scope and exists': async ({ pass, fail }) => {
    for(const { key, module } of config.widgets){
      if(!module.startsWith(scope)) return fail(`${key}: ${module} is outside ${scope}`);
      if(!existsSync(path.join(root, 'public', module.slice(scope.length)))) return fail(`${key}: ${module} does not exist under public/`);
    }
    pass();
  },

  'a widget\'s permission is one the extension declares (or core\'s, or a dependency\'s when it declares none)': async ({ pass, fail }) => {
    for(const { key, permission } of config.widgets){
      if(permission && permissions.size && !permissions.has(permission) && !permission.startsWith('system:')){
        return fail(`${key}: permission "${permission}" is not declared by this extension`);
      }
    }
    pass();
  },

  'every widget module defines the element it is registered with': async ({ pass, fail }) => {
    for(const { key, module, element } of config.widgets){
      const source = await readFile(path.join(root, 'public', module.slice(scope.length)), 'utf8');
      if(!source.includes(`customElements.define('${element}'`)) return fail(`${key}: ${module} never defines <${element}>`);
    }
    pass();
  },
};
