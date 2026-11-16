import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  createClientKey, defaultConfigPath, parseConfig, requireReadyTarget,
  resolveConfigPath, writeAdminKeyHash,
} from "../dist/config.js";
import { initializeConfig } from "../dist/init.js";
import { adminKeyPath, createPrivateFile, initialManagedKey, readManagedKey } from "../dist/state.js";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const execFileAsync = promisify(execFile);

async function withConfig(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-onboarding-"));
  const configPath = path.join(directory, "config.json");
  try {
    await run(configPath, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("platform defaults and explicit config paths", async () => {
  assert.equal(defaultConfigPath({}, "darwin", "/Users/example"),
    path.join("/Users/example", ".config", "telegram-notifs-mcp", "config.json"));
  assert.equal(defaultConfigPath({ LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local" }, "win32", "C:\\Users\\Example"),
    "C:\\Users\\Example\\AppData\\Local\\telegram-notifs-mcp\\config.json");
  await withConfig(async (_filename, home) => {
    const canonical = await resolveConfigPath({ home, platform: "darwin", env: {} });
    const configPath = path.join(home, "custom-config.json");
    assert.equal(await resolveConfigPath({ configPath, env: {} }), configPath);
    assert.equal(await resolveConfigPath({ env: { TELEGRAM_NOTIF_CONFIG_FILE: configPath } }), configPath);
    await initializeConfig({ configPath: canonical, hosted: true, env: {} });
    const original = await readFile(canonical, "utf8");
    const hash = JSON.parse(original).discovery.adminKeySha256;
    const key = await readManagedKey(canonical, hash);
    assert.equal(await resolveConfigPath({ home, platform: "darwin", env: {} }), canonical);
    assert.equal((await initializeConfig({ configPath: await resolveConfigPath({ home, platform: "darwin", env: {} }), hosted: true, env: {} })).created, false);
    assert.equal(await readFile(canonical, "utf8"), original);
    assert.equal(await readManagedKey(canonical, hash), key);
  });
});

test("Windows resolves the default local config path when it exists", { skip: process.platform !== "win32" }, async () => {
  await withConfig(async (_filename, home) => {
    const env = { LOCALAPPDATA: path.join(home, "Local") };
    const configPath = path.join(env.LOCALAPPDATA, "telegram-notifs-mcp", "config.json");
    await initializeConfig({ configPath, env });
    assert.equal(await resolveConfigPath({ home, platform: "win32", env }), configPath);
  });
});

test("local init creates an empty discovery config and preserves user edits", async () => {
  await withConfig(async (configPath) => {
    const first = await initializeConfig({ configPath, env: {} });
    assert.equal(first.created, true);
    assert.equal(first.keyPath, undefined);
    const document = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(document, { targets: {}, clients: {}, discovery: { enabled: true } });
    assert.doesNotThrow(() => parseConfig(JSON.stringify(document), {}));
    document.targets.alerts = { bot: "valid_bot", token: TOKEN, chatId: 123 };
    document.discovery.enabled = false;
    await writeFile(configPath, JSON.stringify(document));
    const original = await readFile(configPath, "utf8");
    const repeated = await initializeConfig({ configPath, env: {} });
    assert.equal(repeated.created, false);
    assert.equal(await readFile(configPath, "utf8"), original);
  });
});

test("hosted init skips the managed key when the platform supplies TELEGRAM_MCP_ADMIN_KEY", async () => {
  await withConfig(async (configPath) => {
    const env = { TELEGRAM_MCP_ADMIN_KEY: "Z9y8X7w6".repeat(8) };
    const initialized = await initializeConfig({ configPath, env, hosted: true });
    assert.equal(initialized.created, true);
    assert.equal(initialized.keyPath, undefined);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).discovery, { enabled: true });
    await assert.rejects(stat(adminKeyPath(configPath)), { code: "ENOENT" });
    await assert.rejects(writeAdminKeyHash({ configPath, rotate: true, env }), /rotate it in your deployment/);
  });
});

test("pending targets require discovery and can never be treated as ready", () => {
  const document = {
    targets: { alerts: { bot: "valid_bot", token: TOKEN } },
    discovery: { enabled: true },
  };
  const config = parseConfig(JSON.stringify(document), {});
  assert.throws(() => requireReadyTarget(config, "alerts"), /has no chatId/);
  assert.throws(() => parseConfig(JSON.stringify(document), { TELEGRAM_MCP_DISCOVERY_ENABLED: "false" }), /requires a chatId/);
  for (const invalid of [0, null, "123", Number.MAX_SAFE_INTEGER + 1]) {
    document.targets.alerts.chatId = invalid;
    assert.throws(() => parseConfig(JSON.stringify(document), {}), /safe-integer chatId/);
  }
  document.targets.alerts.chatId = -1001234567890;
  assert.equal(requireReadyTarget(parseConfig(JSON.stringify(document), {}), "alerts").chatId, -1001234567890);
});

test("hosted init persists one key across concurrent starts and disabled discovery", async () => {
  await withConfig(async (configPath) => {
    const starts = await Promise.all(Array.from({ length: 4 }, () =>
      initializeConfig({ configPath, hosted: true, env: {} })));
    assert.equal(starts.filter((result) => result.created).length, 1);
    const document = JSON.parse(await readFile(configPath, "utf8"));
    const key = await readManagedKey(configPath, document.discovery.adminKeySha256);
    assert.match(key, /^tnm_/);
    assert.equal(JSON.stringify(document).includes(key), false);
    document.targets.alerts = { bot: "valid_bot", token: TOKEN, chatId: 123 };
    document.discovery.enabled = false;
    await writeFile(configPath, JSON.stringify(document));
    await initializeConfig({ configPath, hosted: true, env: {} });
    const repeated = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(repeated.discovery.enabled, false);
    assert.equal(repeated.discovery.adminKeySha256, document.discovery.adminKeySha256);
    assert.equal(await readManagedKey(configPath, repeated.discovery.adminKeySha256), key);
  });
});

test("interrupted first initialization reuses its persisted raw key", async () => {
  await withConfig(async (configPath) => {
    const first = await initialManagedKey(configPath, createClientKey);
    await initializeConfig({ configPath, hosted: true, env: {} });
    const document = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(document.discovery.adminKeySha256, first.keySha256);
  });
});

test("managed administrator rotation updates the raw key and recovers after config commit", async () => {
  await withConfig(async (configPath) => {
    await initializeConfig({ configPath, hosted: true, env: {} });
    const rotated = await writeAdminKeyHash({ configPath, rotate: true, env: {} });
    let document = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(await readManagedKey(configPath, document.discovery.adminKeySha256), rotated.key);

    const next = createClientKey();
    await createPrivateFile(`${adminKeyPath(configPath)}.next`, `${next.key}\n`);
    document.discovery.adminKeySha256 = next.keySha256;
    await writeFile(configPath, JSON.stringify(document));
    await initializeConfig({ configPath, hosted: true, env: {} });
    document = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(await readManagedKey(configPath, document.discovery.adminKeySha256), next.key);
    await assert.rejects(stat(`${adminKeyPath(configPath)}.next`), { code: "ENOENT" });
  });
});

test("missing and mismatched managed secrets fail without silently regenerating", async () => {
  await withConfig(async (configPath) => {
    await initializeConfig({ configPath, hosted: true, env: {} });
    const original = await readFile(configPath, "utf8");
    const wrong = createClientKey();
    await writeFile(adminKeyPath(configPath), wrong.key);
    await assert.rejects(initializeConfig({ configPath, hosted: true, env: {} }), /does not match/);
    assert.equal(await readFile(configPath, "utf8"), original);
    await unlink(adminKeyPath(configPath));
    await assert.rejects(initializeConfig({ configPath, hosted: true, env: {} }), /missing/);
  });
});

test("external administrator hashes and invalid config remain untouched", async () => {
  await withConfig(async (configPath) => {
    const key = createClientKey();
    const document = { targets: {}, discovery: { enabled: true, adminKeySha256: key.keySha256 } };
    await writeFile(configPath, JSON.stringify(document));
    await initializeConfig({ configPath, hosted: true, env: {} });
    await assert.rejects(readManagedKey(configPath, key.keySha256), /No managed administrator key/);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), document);
    await writeFile(configPath, "{bad json");
    await assert.rejects(initializeConfig({ configPath, hosted: true, env: {} }), /valid JSON/);
    assert.equal(await readFile(configPath, "utf8"), "{bad json");
    await assert.rejects(initializeConfig({ configPath, env: { TELEGRAM_NOTIF_CONFIG: "{}" } }), /writable config file/);
  });
});

test("generated state is private on the real host platform", async () => {
  await withConfig(async (configPath) => {
    await initializeConfig({ configPath, hosted: true, env: {} });
    if (process.platform !== "win32") {
      assert.equal((await stat(configPath)).mode & 0o777, 0o600);
      assert.equal((await stat(adminKeyPath(configPath))).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(adminKeyPath(configPath)))).mode & 0o777, 0o700);
    } else {
      for (const filename of [configPath, adminKeyPath(configPath)]) {
        const { stdout } = await execFileAsync("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-Command",
          "$acl = Get-Acl -LiteralPath $env:ACL_TEST_PATH; "
            + "$ids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }); "
            + "@{ protected = $acl.AreAccessRulesProtected; ids = $ids; user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } | ConvertTo-Json -Compress",
        ], { env: { ...process.env, ACL_TEST_PATH: filename } });
        const acl = JSON.parse(stdout);
        assert.equal(acl.protected, true);
        assert.deepEqual(new Set(acl.ids), new Set([acl.user, "S-1-5-18"]));
      }
    }
  });
});

test("initialization rejects symlinked generated state", { skip: process.platform === "win32" }, async () => {
  await withConfig(async (configPath, directory) => {
    const other = path.join(directory, "other.json");
    await writeFile(other, "{}");
    await symlink(other, configPath);
    await assert.rejects(initializeConfig({ configPath, hosted: true, env: {} }), /symbolic-link/);
    assert.equal(await readFile(other, "utf8"), "{}");
  });
});
