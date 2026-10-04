const fs = require('node:fs');
const path = require('node:path');

class FileJournal {
  constructor(filename) { this.filename = filename; }
  load() {
    try { return JSON.parse(fs.readFileSync(this.filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  save(records) {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(records)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.filename);
  }
}
class MemoryJournal {
  constructor() { this.records = {}; }
  load() { return structuredClone(this.records); }
  save(records) { this.records = structuredClone(records); }
}
module.exports = { FileJournal, MemoryJournal };
