const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const targets = ['dist', 'dist-protected'].map((name) => path.resolve(projectRoot, name));

function removeTree(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  for (const entry of fs.readdirSync(target)) {
    removeTree(path.join(target, entry));
  }
  fs.rmdirSync(target);
}

for (const target of targets) {
  const relative = path.relative(projectRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean path outside project: ${target}`);
  }
  // Delete entries explicitly. Besides making every target auditable, this
  // avoids platform/filesystem combinations where recursive rm can return
  // without removing an existing tree.
  removeTree(target);
  if (fs.existsSync(target)) throw new Error(`Build directory cleanup failed: ${target}`);
}
