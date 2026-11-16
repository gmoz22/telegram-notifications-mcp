import { timingSafeEqual, createHash } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { ConfigurationError, effectiveAdminKeySha256, isDiscoveryEnabled } from "./config.js";
import { RateLimiter } from "./rate-limiter.js";
import { createDiscoveryServer, createNotificationServer } from "./server.js";
const ADMIN_CLIENT_ID = "__discovery_admin";
const DISCOVERY_SCOPE = "discovery:read";
function listFromEnvironment(value, fallback) {
    if (value === undefined) {
        return fallback;
    }
    const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (entries.length === 0) {
        throw new ConfigurationError("Host and origin allowlists cannot be empty.");
    }
    return entries;
}
export function authenticateBearer(authorization, clients, adminKeySha256) {
    const [scheme, presentedKey, extra] = (authorization ?? "").split(" ");
    if (scheme?.toLowerCase() !== "bearer"
        || !/^[A-Za-z0-9_-]{32,256}$/.test(presentedKey ?? "")
        || extra !== undefined) {
        return undefined;
    }
    const presentedHash = createHash("sha256").update(presentedKey).digest();
    if (adminKeySha256
        && Object.values(clients ?? {}).some((client) => client.keySha256 === adminKeySha256)) {
        throw new ConfigurationError("The administrator key must differ from every client key.");
    }
    if (adminKeySha256) {
        const storedHash = Buffer.from(adminKeySha256, "hex");
        if (storedHash.length === presentedHash.length && timingSafeEqual(presentedHash, storedHash)) {
            return {
                clientName: ADMIN_CLIENT_ID,
                role: "admin",
                authInfo: {
                    token: presentedKey,
                    clientId: ADMIN_CLIENT_ID,
                    scopes: [DISCOVERY_SCOPE],
                },
            };
        }
    }
    for (const [clientName, client] of Object.entries(clients ?? {})) {
        const storedHash = Buffer.from(client.keySha256, "hex");
        if (storedHash.length === presentedHash.length && timingSafeEqual(presentedHash, storedHash)) {
            return {
                clientName,
                role: "client",
                authInfo: {
                    token: presentedKey,
                    clientId: clientName,
                    scopes: ["notify:send"],
                },
            };
        }
    }
    return undefined;
}
export function createHttpApp(config, env = process.env) {
    const discoveryEnabled = isDiscoveryEnabled(config, env);
    const adminKeySha256 = effectiveAdminKeySha256(config, env);
    if (adminKeySha256
        && Object.values(config.clients ?? {}).some((client) => client.keySha256 === adminKeySha256)) {
        throw new ConfigurationError("The administrator key must differ from every client key.");
    }
    if (discoveryEnabled && !adminKeySha256) {
        throw new ConfigurationError('Hosted discovery requires TELEGRAM_MCP_ADMIN_KEY or "discovery.adminKeySha256".');
    }
    if ((!config.clients || Object.keys(config.clients).length === 0) && !discoveryEnabled) {
        throw new ConfigurationError('Hosted mode requires a client, or enabled discovery with an administrator key.');
    }
    const host = env.TELEGRAM_MCP_HOST ?? "127.0.0.1";
    const allowedHosts = listFromEnvironment(env.TELEGRAM_MCP_ALLOWED_HOSTS, ["localhost", "127.0.0.1", "[::1]"]);
    const allowedOrigins = env.TELEGRAM_MCP_ALLOWED_ORIGINS === undefined
        ? undefined
        : listFromEnvironment(env.TELEGRAM_MCP_ALLOWED_ORIGINS, []);
    const port = Number(env.TELEGRAM_MCP_PORT ?? "3000");
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new ConfigurationError("TELEGRAM_MCP_PORT must be an integer from 1 to 65535.");
    }
    const limiter = new RateLimiter();
    const handler = createMcpHandler(({ authInfo }) => {
        if (discoveryEnabled
            && authInfo?.clientId === ADMIN_CLIENT_ID
            && authInfo.scopes.includes(DISCOVERY_SCOPE)) {
            return createDiscoveryServer({ config });
        }
        const clientName = authInfo?.clientId;
        if (!clientName
            || !authInfo.scopes.includes("notify:send")
            || !config.clients
            || !Object.hasOwn(config.clients, clientName)) {
            throw new ConfigurationError("Authenticated client configuration is unavailable.");
        }
        return createNotificationServer({
            config,
            targetName: config.clients[clientName].target,
            clientName,
            prefix: true,
            rateLimiter: limiter,
        });
    });
    const nodeHandler = toNodeHandler(handler, {
        onerror: () => console.error("MCP HTTP request failed."),
    });
    const app = createMcpExpressApp({
        host,
        allowedHosts,
        ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
        jsonLimit: "32kb",
    });
    app.get("/healthz", (_request, response) => {
        response.status(200).json({ status: "ok" });
    });
    app.all("/mcp", (request, response, next) => {
        const authenticated = authenticateBearer(request.get("authorization"), config.clients, discoveryEnabled ? adminKeySha256 : undefined);
        if (!authenticated) {
            response.setHeader("WWW-Authenticate", "Bearer");
            response.status(401).json({ error: "Unauthorized" });
            return;
        }
        request.auth = authenticated.authInfo;
        next();
    }, (request, response) => {
        void nodeHandler(request, response, request.body);
    });
    app.use((error, _request, response, _next) => {
        if (response.headersSent) {
            return;
        }
        if (typeof error === "object"
            && error !== null
            && "type" in error
            && error.type === "entity.too.large") {
            response.status(413).json({ error: "Request body is too large." });
            return;
        }
        if (typeof error === "object"
            && error !== null
            && "type" in error
            && error.type === "entity.parse.failed") {
            response.status(400).json({ error: "Request body must be valid JSON." });
            return;
        }
        console.error("HTTP request failed.");
        response.status(500).json({ error: "Internal server error." });
    });
    app.locals.telegramMcp = {
        host,
        port,
        handler,
    };
    return app;
}
export function listenHttp(app) {
    const settings = app.locals.telegramMcp;
    if (!settings) {
        throw new ConfigurationError("HTTP server settings are unavailable.");
    }
    return new Promise((resolve, reject) => {
        const server = app.listen(settings.port, settings.host, () => resolve(server));
        server.once("error", reject);
    });
}
