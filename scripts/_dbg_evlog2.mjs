import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-evlog-dbg2-'));
process.env.COAGENT_DATA = dir;
const { createEventLog } = await import('../src/eventlog.js');

const log1 = createEventLog();
for (let i = 1; i <= 10; i++) log1.append({ type: 'message.posted', authorId: 'a', payload: { i } });
console.log('log1.file =', log1.file, '| lastSeq =', log1.lastSeq);

// 直接看文件内容
const raw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
console.log('events.jsonl bytes =', Buffer.byteLength(raw), '| lines =', raw.split('\n').length);

const log2 = createEventLog();
console.log('log2.file =', log2.file, '| lastSeq =', log2.lastSeq);
