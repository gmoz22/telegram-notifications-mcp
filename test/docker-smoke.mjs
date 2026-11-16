import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const docker = async (...args) => (await execFileAsync("docker", args)).stdout.trim();
const name = `telegram-notif-test-${randomUUID()}`;
const volume = `${name}-data`;
let volumeCreated = false;
let containerCreated = false;

async function waitReady(url) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        assert.deepEqual(await response.json(), { status: "ok" });
        return;
      }
      lastError = new Error(`Health check returned HTTP ${response.status}.`);
    } catch (error) {
      if (!(error instanceof TypeError) && error.name !== "TimeoutError") throw error;
      lastError = error;
    }
    await delay(500);
  }
  throw new Error("Docker server did not become ready.", { cause: lastError });
}

async function inspectState() {
  const result = await docker("exec", name, "node", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { readFile, stat } from 'node:fs/promises';
    const file = '/data/config.json';
    const keyFile = file + '.secrets/admin.key';
    const config = JSON.parse(await readFile(file, 'utf8'));
    const key = (await readFile(keyFile, 'utf8')).trim();
    assert.match(key, /^tnm_[A-Za-z0-9_-]{43}$/);
    assert.ok(createHash('sha256').update(key).digest('hex') === config.discovery.adminKeySha256,
      'Managed secret does not match its config hash.');
    for (const [filename, mode] of [[file, 0o600], [keyFile, 0o600], [file + '.secrets', 0o700]]) {
      assert.equal((await stat(filename)).mode & 0o777, mode);
    }
    console.log(JSON.stringify(config));
  `);
  const logs = await execFileAsync("docker", ["logs", name]);
  assert.doesNotMatch(logs.stdout + logs.stderr, /tnm_[A-Za-z0-9_-]{43}/);
  return JSON.parse(result);
}

try {
  await docker("volume", "create", volume);
  volumeCreated = true;
  await docker("create", "--name", name, "--mount", `type=volume,src=${volume},dst=/data`,
    "--publish", "127.0.0.1::3000", "telegram-notifs-mcp:test");
  containerCreated = true;
  await docker("start", name);
  const port = await docker("inspect", "--format",
    '{{(index (index .NetworkSettings.Ports "3000/tcp") 0).HostPort}}', name);
  const url = `http://127.0.0.1:${port}`;
  await waitReady(url);
  const first = await inspectState();
  assert.deepEqual(first.targets, {});
  assert.deepEqual(first.clients, {});
  assert.equal(first.discovery.enabled, true);
  assert.equal((await fetch(`${url}/mcp`, { method: "POST" })).status, 401);

  await docker("restart", name);
  await waitReady(url);
  assert.deepEqual(await inspectState(), first);

  await docker("exec", name, "node", "--input-type=module", "-e", `
    import { createHash } from 'node:crypto';
    import { readFile, writeFile } from 'node:fs/promises';
    const file = '/data/config.json';
    const config = JSON.parse(await readFile(file, 'utf8'));
    config.discovery.enabled = false;
    config.targets.ready = {
      bot: 'test_bot', token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', chatId: 123
    };
    config.clients.project = {
      target: 'ready', keySha256: createHash('sha256').update('test-project-key').digest('hex')
    };
    await writeFile(file, JSON.stringify(config));
  `);
  await docker("restart", name);
  await waitReady(url);
  const completed = await inspectState();
  assert.equal(completed.discovery.enabled, false);
  assert.equal(completed.discovery.adminKeySha256, first.discovery.adminKeySha256);
  console.log("Docker bootstrap, persistence, private permissions, and disabled discovery verified.");
} finally {
  if (containerCreated) await docker("rm", "--force", name);
  if (volumeCreated) await docker("volume", "rm", volume);
}
