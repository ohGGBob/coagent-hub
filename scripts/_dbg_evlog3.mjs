import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-evlog-dbg3-'));
process.env.COAGENT_DATA = dir;
const { createEventLog } = await import('../src/eventlog.js');

console.error('STEP 1: create log1');
const log1 = createEventLog();
console.error('STEP 2: append 10');
for (let i = 1; i <= 10; i++) log1.append({ type: 'message.posted', authorId: 'a', payload: { i } });
console.error('STEP 3: log1.lastSeq =', log1.lastSeq);
console.error('STEP 4: create log2 (before)');
const log2 = createEventLog();
console.error('STEP 5: log2.lastSeq =', log2.lastSeq);
process.exit(0);
