/**
 * 授权签发工具（维护者专用，不入库私钥）。
 *
 * 用法：
 *   node scripts/license-tool.mjs issue --org "ACME" --edition pro --seats 10 --days 365
 *   node scripts/license-tool.mjs verify <key>
 *   node scripts/license-tool.mjs pubkey
 *
 * 私钥默认读取 scripts/dev-keys/ed25519-private.pem（已在 .gitignore 排除）。
 * 签发命令输出可直接粘贴到面板「设置 → 授权与版别 → 激活授权」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, sign, verify, createPublicKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRIVATE_KEY_PATH = path.join(HERE, 'dev-keys', 'ed25519-private.pem');
const PUBLIC_KEY_DER_B64 = 'MCowBQYDK2VwAyEA4e+f2kbqCHjMs5KrHxnmDS/3mPi1OXiUbMloAN4ZcHE=';

function loadPrivateKey() {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    console.error(`私钥不存在：${PRIVATE_KEY_PATH}\n首次使用请先运行：\n  node -e "const {generateKeyPairSync}=require('crypto');const {publicKey,privateKey}=generateKeyPairSync('ed25519');fs.writeFileSync('${PRIVATE_KEY_PATH}',privateKey.export({type:'pkcs8',format:'pem'}));console.log(publicKey.export({type:'spki',format:'der'}).toString('base64'))"`);
    process.exit(1);
  }
  return createPrivateKey(fs.readFileSync(PRIVATE_KEY_PATH));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      args[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
      if (args[key] !== true) i++;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function issue(args) {
  const privateKey = loadPrivateKey();
  const org = args.org ?? '未命名组织';
  const edition = args.edition ?? 'pro';
  const seats = Number(args.seats ?? 10);
  const days = Number(args.days ?? 365);
  if (edition !== 'pro' && edition !== 'enterprise') {
    console.error('edition 仅支持 pro / enterprise');
    process.exit(1);
  }
  const payload = {
    org,
    edition,
    seats,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
  };
  const data = JSON.stringify(payload, null, 0);
  const signature = sign(null, Buffer.from(data, 'utf8'), privateKey).toString('base64');
  const key = Buffer.from(JSON.stringify({ data, signature }), 'utf8').toString('base64');
  console.log('===== 授权 key（一行，复制到面板激活） =====');
  console.log(key);
  console.log('===========================================');
  console.log(`组织：${org}  版别：${edition}  席位：${seats}  过期：${payload.expiresAt}`);
  return key;
}

function verifyKey(key) {
  const publicKey = createPublicKey({ key: Buffer.from(PUBLIC_KEY_DER_B64, 'base64'), format: 'der', type: 'spki' });
  const envelope = JSON.parse(Buffer.from(key, 'base64').toString('utf8'));
  const ok = verify(null, Buffer.from(envelope.data, 'utf8'), publicKey, Buffer.from(envelope.signature, 'base64'));
  console.log(ok ? '✓ 签名有效' : '✗ 签名无效');
  if (ok) {
    const payload = JSON.parse(envelope.data);
    console.log(JSON.stringify(payload, null, 2));
    const expired = Date.parse(payload.expiresAt) < Date.now();
    if (expired) console.log('✗ 已过期：' + payload.expiresAt);
    else console.log('✓ 有效至：' + payload.expiresAt);
  }
  process.exit(ok ? 0 : 1);
}

const args = parseArgs(process.argv);
const cmd = args._[0] ?? 'help';
if (cmd === 'issue') {
  issue(args);
} else if (cmd === 'verify') {
  const key = args._[1];
  if (!key) { console.error('用法：node scripts/license-tool.mjs verify <key>'); process.exit(1); }
  verifyKey(key);
} else if (cmd === 'pubkey') {
  console.log(PUBLIC_KEY_DER_B64);
} else {
  console.log(`用法：
  node scripts/license-tool.mjs issue --org "组织名" --edition pro --seats 10 --days 365
  node scripts/license-tool.mjs verify <key>
  node scripts/license-tool.mjs pubkey`);
}
