import { readFile, readdir, access } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

/*
  Every icon a page or component names has to exist in a set kempo serves. An icon that does not exist
  renders as nothing at all, with no error anywhere, so a typo or a plausible-sounding Material Symbols
  name that kempo does not ship goes unnoticed until someone wonders why a button has no picture.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sets = [
  path.join(root, 'node_modules', 'kempo', 'dist', 'kempo', 'icons'),
  path.join(root, 'node_modules', 'kempo', 'src', 'kempo', 'icons'),
  path.join(root, 'node_modules', 'kempo-ui', 'icons'),
];

const expect = (condition, message) => {
  if(!condition) throw new Error(message);
};

const exists = target => access(target).then(() => true, () => false);

const walk = async (dir) => {
  const files = [];
  for(const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])){
    if(entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if(entry.isDirectory()) files.push(...await walk(full));
    else if(/\.(js|html)$/.test(entry.name)) files.push(full);
  }
  return files;
};

export default {
  'every literal icon name a page or component uses exists in a set kempo serves': async ({ pass }) => {
    const names = new Map();
    for(const dir of ['public', 'admin']){
      for(const file of await walk(path.join(root, dir))){
        const text = await readFile(file, 'utf8');
        for(const match of text.matchAll(/<k-icon[^>]*\bname="([a-z0-9_-]+)"/g)) names.set(match[1], path.relative(root, file));
      }
    }
    expect(names.size > 0, 'the check should find some icons to check');

    for(const [name, file] of names){
      const found = await Promise.all(sets.map(set => exists(path.join(set, `${name}.svg`))));
      expect(found.some(Boolean), `${file} uses the icon "${name}", which no icon set kempo serves contains`);
    }
    pass(`${names.size} icons`);
  }
};
