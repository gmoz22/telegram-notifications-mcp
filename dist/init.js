import { readFile } from "node:fs/promises";
import path from "node:path";
import { ConfigurationError, createClientKey, environmentAdminKey, isDiscoveryEnabled, parseConfig, resolveConfigPath, writeKeyConfig, } from "./config.js";
import { adminKeyPath, createPrivateFile, ensureStateDirectory, initialManagedKey, inspectStatePath, readManagedKey, } from "./state.js";
export function initializeConfig(options = {}) {
    return initializeAttempt(options, 0);
}
async function initializeAttempt(options, attempt) {
    if (attempt > 3)
        throw new ConfigurationError("Configuration kept changing during initialization; retry after edits finish.");
    const env = options.env ?? process.env;
    if (env.TELEGRAM_NOTIF_CONFIG !== undefined) {
        throw new ConfigurationError("Automatic initialization requires a writable config file, not TELEGRAM_NOTIF_CONFIG.");
    }
    const configPath = await resolveConfigPath(options);
    await ensureStateDirectory(path.dirname(configPath));
    const existed = await inspectStatePath(configPath);
    const original = existed ? await readFile(configPath, "utf8") : undefined;
    const serialized = original ?? JSON.stringify({ targets: {}, clients: {}, discovery: { enabled: true } });
    const config = parseConfig(serialized, env, {
        allowEmptyTargets: true, allowIncompleteTargets: true, allowUnresolvedTokenReferences: true,
    });
    const document = JSON.parse(serialized);
    let keyPath;
    let changed = false;
    const managedKey = options.hosted && environmentAdminKey(env) === undefined;
    if (managedKey && (!existed || isDiscoveryEnabled(config, env))) {
        if (config.discovery?.adminKeySha256) {
            if (await readManagedKey(configPath, config.discovery.adminKeySha256, false)) {
                keyPath = adminKeyPath(configPath);
            }
        }
        else {
            const generated = await initialManagedKey(configPath, createClientKey);
            if (Object.values(config.clients ?? {}).some((client) => client.keySha256 === generated.keySha256)) {
                throw new ConfigurationError("The managed administrator key conflicts with a client key.");
            }
            document.discovery = {
                ...(config.discovery ?? { enabled: false }),
                adminKeySha256: generated.keySha256,
            };
            keyPath = adminKeyPath(configPath);
            changed = true;
        }
    }
    else if (managedKey && config.discovery?.adminKeySha256) {
        if (await readManagedKey(configPath, config.discovery.adminKeySha256, false)) {
            keyPath = adminKeyPath(configPath);
        }
    }
    if (!existed) {
        const created = await createPrivateFile(configPath, `${JSON.stringify(document, null, 2)}\n`);
        if (!created) {
            return initializeAttempt(options, attempt + 1);
        }
        return { configPath, created, keyPath };
    }
    if (changed) {
        if (await readFile(configPath, "utf8") !== original) {
            return initializeAttempt(options, attempt + 1);
        }
        await writeKeyConfig(configPath, document);
    }
    return { configPath, created: false, keyPath };
}
