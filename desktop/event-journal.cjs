const fs = require('node:fs');
const path = require('node:path');

class EventJournal {
  constructor(file) { this.file = file; fs.mkdirSync(path.dirname(file), { recursive: true }); }
  append(event) {
    const line = JSON.stringify({ ...event, journaledAt: new Date().toISOString() }) + '\n';
    fs.appendFileSync(this.file, line, { encoding: 'utf8' });
  }
}

module.exports = { EventJournal };
