# Telegram Notifications MCP

![MCP Server](https://badge.mcpx.dev?type=server) ![Telegram Bot](https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white) ![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-5FA04E?logo=nodedotjs&logoColor=white) [![npm](https://img.shields.io/npm/v/telegram-notifications-mcp?color=CB3837&logo=npm)](https://www.npmjs.com/package/telegram-notifications-mcp) ![License: MIT](https://img.shields.io/badge/license-MIT-blue)

A simple secure MCP server for Telegram Bot API notifications.

<br/>

## What it does

Your AI agent gets one tool, `send_notification`. Each project is locked to one named **target**: a bot plus a chat, group, channel or forum topic. The agent cannot read your chats or pick a different recipient. Your personal account info is never used.

- **Local:** each MCP client starts its own process on your machine.
- **Hosted:** one HTTPS server serves many projects. Each project has its own key mapped to one target.

You need Node.js 20+ for local use, or Docker for hosted use.

<br/>

## Table of Contents

- [Before you start: create a bot](#before-you-start-create-a-bot)
- [macOS (local)](#macos-local)
- [Windows (local)](#windows-local)
- [Docker Compose (hosted)](#docker-compose-hosted)
- [Coolify (hosted)](#coolify-hosted)
- [Reference](#reference)

<br/>

## Before you start: create a bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Follow the prompts. Save the **HTTP API token** somewhere private.
3. Note the bot's **username** (the `t.me/<username>` part).

Only BotFather issues bot tokens. Never paste a token into an AI prompt, a repository, a browser URL, or an online "chat ID" service.

Then pick your setup:

- [macOS (local)](#macos-local)
- [Windows (local)](#windows-local)
- [Docker Compose (hosted)](#docker-compose-hosted)
- [Coolify (hosted)](#coolify-hosted)

The examples use the target name `dev-status` and the bot `My_Alerts_Bot`. Replace both with your own.

<br/>

## macOS (local)

### 1. Install and initialize

```sh
npm install --global telegram-notifications-mcp
telegram-notifs-mcp init
```

The npm package is `telegram-notifications-mcp`; the command it installs is `telegram-notifs-mcp`. `init` creates `~/.config/telegram-notifs-mcp/config.json` with discovery on.

An existing config from before the rename is reused; open the path printed by `init` instead of the example below.

### 2. Add your target

```sh
open -e "$HOME/.config/telegram-notifs-mcp/config.json"
```

Fill in `targets`, leaving everything else as is:

```json
{
  "targets": {
    "dev-status": {
      "bot": "My_Alerts_Bot",
      "token": "123456789:your-botfather-token"
    }
  },
  "clients": {},
  "discovery": {
    "enabled": true
  }
}
```

The file is private to your account. Don't add a `chatId` yet.

### 3. Say hello in Telegram

Do one of these in the destination you want notifications in:

- **Private chat:** open `t.me/My_Alerts_Bot` and press **Start**.
- **Group:** add the bot and send `/start@My_Alerts_Bot`. For a forum topic, send it inside that topic.
- **Channel:** add the bot as an admin that can post, then publish a post.

### 4. Discover the chat ID

Make sure nothing else is polling this bot (another script, a hosted copy of this server in discovery mode, etc.). Then use either option.

**Command:**

```sh
telegram-notifs-mcp discover --target dev-status --confirm-no-other-poller
```

**Agent:** add a temporary entry to your _user-level_ MCP config (not the project's), then ask your agent to call `discover_chats` with `{"source": "target", "name": "dev-status", "confirmNoOtherPoller": true}`:

```json
{
  "servers": {
    "telegram-discovery": {
      "type": "stdio",
      "command": "telegram-notifs-mcp",
      "args": ["serve", "--discovery"]
    }
  }
}
```

Either way, you get something like:

```json
{
  "chats": [
    {
      "chatId": -1001234567890,
      "type": "supergroup",
      "title": "Team alerts",
      "threadIds": [42]
    }
  ]
}
```

### 5. Save the chat ID and test

Add `chatId` (keep the minus sign) and, for a forum topic only, `threadId`:

```json
"dev-status": {
  "bot": "My_Alerts_Bot",
  "token": "123456789:your-botfather-token",
  "chatId": -1001234567890,
  "threadId": 42
}
```

```sh
telegram-notifs-mcp check --target dev-status
telegram-notifs-mcp test-send dev-status
```

`check` sends nothing. `test-send` sends one real message; look for it in Telegram.

### 6. Turn off discovery

Set `"enabled": false` under `discovery` and remove the temporary `telegram-discovery` MCP entry if you added one.

### 7. Connect your project

In the project's `.vscode/mcp.json`:

```json
{
  "servers": {
    "telegram-notifs-mcp": {
      "type": "stdio",
      "command": "telegram-notifs-mcp",
      "args": ["serve", "--target", "dev-status"]
    }
  }
}
```

Add `"--label", "my-project"` to the args to prefix messages with a project name. Other MCP clients use the same command and args in their own format. Every local project shares the same `config.json`; each is locked to the target in its own args.

<br/>

## Windows (local)

Run these in PowerShell.

### 1. Install and initialize

```powershell
npm install --global telegram-notifications-mcp
telegram-notifs-mcp init
```

The npm package is `telegram-notifications-mcp`; the command it installs is `telegram-notifs-mcp`. `init` creates `%LOCALAPPDATA%\telegram-notifs-mcp\config.json` with discovery on. Access is restricted to your account automatically.

An existing config from before the rename is reused; open the path printed by `init` instead of the example below.

### 2. Add your target

```powershell
notepad "$env:LOCALAPPDATA\telegram-notifs-mcp\config.json"
```

Fill in `targets`, leaving everything else as is:

```json
{
  "targets": {
    "dev-status": {
      "bot": "My_Alerts_Bot",
      "token": "123456789:your-botfather-token"
    }
  },
  "clients": {},
  "discovery": {
    "enabled": true
  }
}
```

Don't add a `chatId` yet.

### 3. Say hello in Telegram

Do one of these in the destination you want notifications in:

- **Private chat:** open `t.me/My_Alerts_Bot` and press **Start**.
- **Group:** add the bot and send `/start@My_Alerts_Bot`. For a forum topic, send it inside that topic.
- **Channel:** add the bot as an admin that can post, then publish a post.

### 4. Discover the chat ID

Make sure nothing else is polling this bot. Then use either option.

**Command:**

```powershell
telegram-notifs-mcp discover --target dev-status --confirm-no-other-poller
```

**Agent:** add a temporary entry to your _user-level_ MCP config (not the project's), then ask your agent to call `discover_chats` with `{"source": "target", "name": "dev-status", "confirmNoOtherPoller": true}`:

```json
{
  "servers": {
    "telegram-discovery": {
      "type": "stdio",
      "command": "telegram-notifs-mcp",
      "args": ["serve", "--discovery"]
    }
  }
}
```

Either way, look for the `chatId` (and `threadIds` for forum topics) in the `chats` list.

### 5. Save the chat ID and test

Add `chatId` (keep the minus sign) and, for a forum topic only, `threadId`:

```json
"dev-status": {
  "bot": "My_Alerts_Bot",
  "token": "123456789:your-botfather-token",
  "chatId": -1001234567890,
  "threadId": 42
}
```

```powershell
telegram-notifs-mcp check --target dev-status
telegram-notifs-mcp test-send dev-status
```

`check` sends nothing. `test-send` sends one real message; look for it in Telegram.

### 6. Turn off discovery

Set `"enabled": false` under `discovery` and remove the temporary `telegram-discovery` MCP entry if you added one.

### 7. Connect your project

In the project's `.vscode/mcp.json`:

```json
{
  "servers": {
    "telegram-notifs-mcp": {
      "type": "stdio",
      "command": "telegram-notifs-mcp",
      "args": ["serve", "--target", "dev-status"]
    }
  }
}
```

Add `"--label", "my-project"` to the args to prefix messages with a project name. Other MCP clients use the same command and args in their own format. If your client can't start `telegram-notifs-mcp`, see [Troubleshooting](#troubleshooting).

<br/>

## Docker Compose (hosted)

Run these on your server. You also need an HTTPS reverse proxy in front of port 3000 (Caddy, nginx, Traefik, etc.); Compose only listens on `127.0.0.1:3000`.

### 1. Configure and start

```sh
git clone https://github.com/gmoz22/telegram-notifications-mcp.git
cd telegram-notifications-mcp
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

```sh
TELEGRAM_DEV_BOT_TOKEN=123456789:your-botfather-token
TELEGRAM_MCP_ALLOWED_HOSTS=notify.example.com
```

```sh
docker compose up --build -d
```

First start creates `/data/config.json` with discovery on, plus a private administrator key. To use other token variable names, add them to the `environment` list in `docker-compose.yml`.

### 2. Add your target

```sh
docker compose exec telegram-notifs-mcp vi /data/config.json
```

Add your target to `targets`. Keep the generated `discovery` block as is. The token is a reference to the `.env` variable:

```json
"targets": {
  "dev-status": {
    "bot": "My_Alerts_Bot",
    "token": "${TELEGRAM_DEV_BOT_TOKEN}"
  }
}
```

```sh
docker compose restart telegram-notifs-mcp
```

### 3. Say hello in Telegram

Do one of these in the destination you want notifications in:

- **Private chat:** open `t.me/My_Alerts_Bot` and press **Start**.
- **Group:** add the bot and send `/start@My_Alerts_Bot`. For a forum topic, send it inside that topic.
- **Channel:** add the bot as an admin that can post, then publish a post.

### 4. Discover the chat ID

Make sure nothing else is polling this bot. Then use either option.

**Command:**

```sh
docker compose exec telegram-notifs-mcp node dist/cli.js discover \
  --target dev-status --confirm-no-other-poller
```

**Agent:** get the administrator key from a trusted terminal:

```sh
docker compose exec telegram-notifs-mcp node dist/cli.js admin-key show
```

Add a temporary entry to your _user-level_ VS Code MCP config. VS Code prompts for the key once and stores it securely:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "telegram-admin-key",
      "description": "Telegram MCP administrator key",
      "password": true
    }
  ],
  "servers": {
    "telegram-discovery": {
      "type": "http",
      "url": "https://notify.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${input:telegram-admin-key}"
      }
    }
  }
}
```

Ask your agent to call `discover_chats` with `{"source": "target", "name": "dev-status", "confirmNoOtherPoller": true}`. Never paste the key into the chat itself. This key can only discover; it cannot send.

Either way, look for the `chatId` (and `threadIds` for forum topics) in the `chats` list.

### 5. Save the chat ID and test

Edit `/data/config.json` again and add `chatId` (keep the minus sign) and, for a forum topic only, `threadId`:

```json
"dev-status": {
  "bot": "My_Alerts_Bot",
  "token": "${TELEGRAM_DEV_BOT_TOKEN}",
  "chatId": -1001234567890,
  "threadId": 42
}
```

```sh
docker compose restart telegram-notifs-mcp
docker compose exec telegram-notifs-mcp node dist/cli.js check --target dev-status
docker compose exec telegram-notifs-mcp node dist/cli.js test-send dev-status
```

### 6. Create a project key

Do this **before** turning off discovery: hosted mode needs at least one project key once discovery is off.

```sh
docker compose exec telegram-notifs-mcp node dist/cli.js keygen \
  --client my-project --target dev-status
```

The key is printed once; copy it now. Only its hash is stored.

### 7. Turn off discovery

In `/data/config.json`, set `"enabled": false` under `discovery`. Then:

```sh
docker compose restart telegram-notifs-mcp
```

Remove the temporary `telegram-discovery` MCP entry if you added one.

### 8. Connect your project

In the project's `.vscode/mcp.json`:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "telegram-notif-key",
      "description": "Telegram MCP project key",
      "password": true
    }
  ],
  "servers": {
    "telegram-notifs-mcp": {
      "type": "http",
      "url": "https://notify.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${input:telegram-notif-key}"
      }
    }
  }
}
```

Enter the project key from step 6 when prompted. Other MCP clients need the same URL and `Authorization` header, using their own secret mechanism.

<br/>

## Coolify (hosted)

### 1. Create the resource

1. In Coolify, create a new resource from the public repository `https://github.com/gmoz22/telegram-notifications-mcp`.
2. Choose the **Docker Compose** build pack and `docker-compose.yml`.
3. In **Environment Variables**, set:
   - `TELEGRAM_DEV_BOT_TOKEN` to your BotFather token.
   - `TELEGRAM_MCP_ALLOWED_HOSTS` to your domain, for example `notify.example.com`.
4. Assign your domain to the `telegram-notifs-mcp` service on port 3000, for example `https://notify.example.com:3000`.
5. Deploy.

Coolify generates `TELEGRAM_MCP_ADMIN_KEY` automatically and shows it in the **Environment Variables** tab. It stays the same across redeploys. To use other token variable names, add them to the `environment` list in `docker-compose.yml`.

### 2. Add your target

Open the service's **Terminal** in Coolify and run:

```sh
vi /data/config.json
```

Add your target to `targets`. Keep the generated `discovery` block as is. The token is a reference to the Coolify variable:

```json
"targets": {
  "dev-status": {
    "bot": "My_Alerts_Bot",
    "token": "${TELEGRAM_DEV_BOT_TOKEN}"
  }
}
```

Restart the service.

### 3. Say hello in Telegram

Do one of these in the destination you want notifications in:

- **Private chat:** open `t.me/My_Alerts_Bot` and press **Start**.
- **Group:** add the bot and send `/start@My_Alerts_Bot`. For a forum topic, send it inside that topic.
- **Channel:** add the bot as an admin that can post, then publish a post.

### 4. Discover the chat ID

Make sure nothing else is polling this bot. Then use either option.

**Command:** in the Coolify terminal:

```sh
node dist/cli.js discover --target dev-status --confirm-no-other-poller
```

**Agent:** copy `TELEGRAM_MCP_ADMIN_KEY` from Coolify's **Environment Variables** tab. Add a temporary entry to your _user-level_ VS Code MCP config. VS Code prompts for the key once and stores it securely:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "telegram-admin-key",
      "description": "Telegram MCP administrator key",
      "password": true
    }
  ],
  "servers": {
    "telegram-discovery": {
      "type": "http",
      "url": "https://notify.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${input:telegram-admin-key}"
      }
    }
  }
}
```

Ask your agent to call `discover_chats` with `{"source": "target", "name": "dev-status", "confirmNoOtherPoller": true}`. Never paste the key into the chat itself. This key can only discover; it cannot send.

Either way, look for the `chatId` (and `threadIds` for forum topics) in the `chats` list.

### 5. Save the chat ID and test

Edit `/data/config.json` again and add `chatId` (keep the minus sign) and, for a forum topic only, `threadId`:

```json
"dev-status": {
  "bot": "My_Alerts_Bot",
  "token": "${TELEGRAM_DEV_BOT_TOKEN}",
  "chatId": -1001234567890,
  "threadId": 42
}
```

Restart the service, then in the terminal:

```sh
node dist/cli.js check --target dev-status
node dist/cli.js test-send dev-status
```

### 6. Create a project key

Do this **before** turning off discovery: hosted mode needs at least one project key once discovery is off.

```sh
node dist/cli.js keygen --client my-project --target dev-status
```

The key is printed once; copy it now. Only its hash is stored.

### 7. Turn off discovery

In `/data/config.json`, set `"enabled": false` under `discovery`, then restart the service. Remove the temporary `telegram-discovery` MCP entry if you added one.

### 8. Connect your project

In the project's `.vscode/mcp.json`:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "telegram-notif-key",
      "description": "Telegram MCP project key",
      "password": true
    }
  ],
  "servers": {
    "telegram-notifs-mcp": {
      "type": "http",
      "url": "https://notify.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${input:telegram-notif-key}"
      }
    }
  }
}
```

Enter the project key from step 6 when prompted. Other MCP clients need the same URL and `Authorization` header, using their own secret mechanism.

<br/>

## Reference

- [Config file shape and rules](#config-file-shape-and-rules)
- [Config file locations and overrides](#config-file-locations-and-overrides)
- [Environment variables](#environment-variables)
- [Commands](#commands)
- [MCP tools](#mcp-tools)
- [Telegram limits](#mcp-tools)
- [Applying changes](#applying-changes)
- [Adding another destination later](#adding-another-destination-later)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)

### Config file shape and rules

A complete config with a local target and a hosted project:

```json
{
  "targets": {
    "dev-status": {
      "bot": "My_Alerts_Bot",
      "token": "123456789:your-botfather-token",
      "chatId": 123456789
    },
    "ops-alerts": {
      "bot": "My_Ops_Bot",
      "token": "${TELEGRAM_OPS_BOT_TOKEN}",
      "chatId": -1001234567890,
      "threadId": 42
    }
  },
  "clients": {
    "my-project": {
      "target": "ops-alerts",
      "keySha256": "written-by-keygen"
    }
  },
  "discovery": {
    "enabled": false
  }
}
```

| Field | Rules |
| --- | --- |
| Target and client names | Lowercase letters, digits, and single hyphens, such as `dev-status`. |
| `bot` | The bot's username, 5-32 letters, digits, or `_`. `check` verifies it matches the token. |
| `token` | A literal BotFather token, or exactly `${VAR_NAME}` (uppercase) to read an environment variable. |
| `chatId` | A non-zero integer. Groups and channels are negative; keep the minus sign. |
| `threadId` | Optional positive integer, only for forum topics. |
| `clients` | Hosted only. Written by `keygen`; maps a project to one target with a key hash. |
| `discovery.enabled` | `true` during setup, `false` afterward. |
| `discovery.adminKeySha256` | Hosted only. Written automatically; it is a hash, not a usable key. |

Other rules:

- Targets accept only `bot`, `token`, `chatId`, and `threadId`.
- A target without `chatId` is allowed only while discovery is on. It can be discovered but cannot send. Never use `0` or a placeholder.
- Every `${VAR_NAME}` token must resolve, even after setup.
- A literal token makes the file a credential. Never commit it or copy it into a project.

### Config file locations and overrides

| Platform         | Default path                                     |
| ---------------- | ------------------------------------------------ |
| macOS / Linux    | `~/.config/telegram-notifs-mcp/config.json`      |
| Windows          | `%LOCALAPPDATA%\telegram-notifs-mcp\config.json` |
| Docker / Coolify | `/data/config.json` (persistent volume)          |

The first match wins:

1. `TELEGRAM_NOTIF_CONFIG`: the whole JSON document as an environment variable (read-only; `init` and `keygen` won't work).
2. `--config /path/to/file.json` on any command.
3. `TELEGRAM_NOTIF_CONFIG_FILE`: a file path.
4. The default path above, or an existing legacy file.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_NOTIF_CONFIG` | Inline JSON config; overrides any file. |
| `TELEGRAM_NOTIF_CONFIG_FILE` | Config file path (`/data/config.json` in Docker). |
| `TELEGRAM_MCP_DISCOVERY_ENABLED` | `true` or `false`; overrides `discovery.enabled` when set. |
| `TELEGRAM_MCP_ADMIN_KEY` | Hosted admin key (32-256 of `A-Z a-z 0-9 - _`); replaces the managed key. Coolify sets it. |
| `TELEGRAM_MCP_ALLOWED_HOSTS` | Comma-separated hostnames accepted over HTTP, such as `notify.example.com`. |
| `TELEGRAM_MCP_ALLOWED_ORIGINS` | Optional browser origins to allow. |
| `TELEGRAM_MCP_HOST` | HTTP bind address (`127.0.0.1`; `0.0.0.0` in Docker). |
| `TELEGRAM_MCP_PORT` | HTTP port, default `3000`. |
| `TELEGRAM_*_BOT_TOKEN` | Any name you reference as `${VAR_NAME}` in a target's `token`. |

### Commands

In Docker, prefix commands with `docker compose exec telegram-notifs-mcp node dist/cli.js`. In the Coolify terminal, use `node dist/cli.js`.

| Command | What it does |
| --- | --- |
| `init` | Creates the config with discovery on. Safe to rerun. |
| `init --hosted` | Also creates the managed admin key (done automatically in Docker). |
| `discover --target <name> --confirm-no-other-poller` | Lists recent chats and topics for the target's bot. |
| `check [--target <name>]` | Verifies bot and chat with Telegram; sends nothing. |
| `test-send <target>` | Sends one real test message. |
| `serve --target <name> [--label <text>]` | Starts the local MCP server for one target. |
| `serve --discovery` | Starts a local admin-only discovery MCP server. |
| `serve --http [--initialize]` | Starts the hosted HTTP server (Docker default). |
| `keygen --client <name> --target <name>` | Creates a hosted project key; add `--rotate` to replace it. |
| `keygen --admin [--rotate]` | Creates or replaces the managed admin key. |
| `admin-key show` | Prints the managed admin key. |

All commands accept `--config <file>`.

### MCP tools

`send_notification` is the only tool for project clients:

| Argument | Details |
| --- | --- |
| `text` | Required, 1-4096 characters. Text that looks like a bot token is rejected. |
| `format` | `plain` (default) or `html` ([Telegram's HTML subset](https://core.telegram.org/bots/api#html-style)). |
| `silent` | Optional; `true` delivers without a notification sound. |

Hosted messages are prefixed with the client name. Local messages are prefixed only with `--label`. Failed sends are not retried, and success is reported only after Telegram confirms delivery.

`discover_chats` is the only tool for admin clients, and only while discovery is on:

| Argument               | Details                         |
| ---------------------- | ------------------------------- |
| `source`               | `target` to use a target's bot. |
| `name`                 | The target name.                |
| `confirmNoOtherPoller` | Must be `true`.                 |

It returns chat IDs, types, titles, and forum topic IDs, never message text, tokens, or webhook URLs. Treat titles as untrusted text.

### Telegram limits

Discovery uses Telegram's [`getUpdates`](https://core.telegram.org/bots/api#getupdates):

- It is **not a list of every chat**. Telegram keeps updates for only 24 hours, so say hello in the destination shortly before you discover.
- It reads at most 100 pending updates. `mayHaveMore: true` means older updates may be hiding newer chats.
- It doesn't mark updates as read, so repeated calls can return the same results.
- It cannot run while the bot has a webhook. Discovery refuses rather than removing it.
- It cannot detect another process polling the same bot. Running both can cause conflicts, which is why you must confirm no other poller.

For sending:

- Messages are limited to 4096 characters.
- Telegram allows roughly one message per second per chat, about 20 per minute in a group, and about 30 per second per bot.
- The hosted server also limits each target to one send per second and each project to 30 sends per minute. Limits are per process; replicas don't share them.
- Local processes have no shared limiter; Telegram's limits still apply.

### Applying changes

| Setup | After editing `config.json` | After changing environment variables |
| --- | --- | --- |
| macOS / Windows commands | Nothing; each command rereads the file. | Rerun in a shell with the new value. |
| macOS / Windows MCP | Restart the server from your MCP client. | Restart the MCP client's server. |
| Docker Compose | `docker compose restart telegram-notifs-mcp` | `docker compose up -d --force-recreate` |
| Coolify | Restart the service. | Redeploy. |

`keygen` changes also need a restart in hosted mode.

### Updating and pinning versions

Local installs come from [npm](https://www.npmjs.com/package/telegram-notifications-mcp):

```sh
npm install --global telegram-notifications-mcp@latest   # update
npm install --global telegram-notifications-mcp@1        # stay on 1.x
```

To pin an exact release, append its version, for example `@1.0.2` if that release is available. Restart your MCP servers after updating and change their configured command. Your `config.json` is not touched.

To skip the global install, an MCP entry can run the package through `npx` instead:

```json
{
  "type": "stdio",
  "command": "npx",
  "args": [
    "--yes",
    "telegram-notifications-mcp@1",
    "serve",
    "--target",
    "dev-status"
  ]
}
```

Run `npx --yes telegram-notifications-mcp@1 init` once to create the config. The first start downloads the package, so it is slower.

Docker and Coolify build from this repository, so redeploy to update. You can pin a Git tag once a corresponding release tag exists.

When upgrading an existing Compose deployment, preserve the original Compose project name and its `telegram-notif-data` volume. The service is now named `telegram-notifs-mcp`; remove the old service container during the upgrade, for example with `docker compose up --build -d --remove-orphans` using the same project name. That option also removes any other orphan containers in the project, so inspect them first. If the checkout directory changed, use `-p <old-project>` or `COMPOSE_PROJECT_NAME` to select the original project. Do not remove the volume. In Coolify, confirm the renamed service retains the existing `/data` volume and update its domain routing before deploying.

### Adding another destination later

1. Turn discovery back on (`"enabled": true`, or set `TELEGRAM_MCP_DISCOVERY_ENABLED=true`) and restart if hosted.
2. Add the new target without a `chatId`.
3. Repeat steps 3-5 of your setup.
4. Hosted: create a project key for it with `keygen`.
5. Turn discovery off again.

### Security notes

- Keep `config.json` private and out of repositories. `init` restricts its permissions automatically.
- Never put bot tokens or keys in prompts, project files, or logs.
- The **admin key** can only discover chats. A **project key** can only send to its one target. Never give a project the admin key.
- Only key hashes are stored for project keys; a lost key must be rotated.
- Anyone who can see Coolify's environment variables can read `TELEGRAM_MCP_ADMIN_KEY`.
- In plain Docker, the managed admin key lives in `/data/config.json.secrets/admin.key`. Back up all of `/data`.
- Always serve hosted mode over HTTPS.
- Keep discovery off except during setup.

### Troubleshooting

| Message or symptom | Fix |
| --- | --- |
| `Target "x" has no chatId. Complete discovery before sending.` | Run discovery and add the `chatId`. |
| `Target "x" requires a chatId when discovery is disabled.` | Add the `chatId`, remove the target, or turn discovery back on. |
| `Environment variable X for ... is not set.` | Set it for the process running the server or command. |
| `... token does not match the configured bot username.` | Fix the `bot` username or the token. |
| `Discovery is disabled.` | Turn discovery on and restart if hosted. |
| `This bot has a webhook; getUpdates cannot be used.` | Get IDs from the webhook's own logs, or use a different bot. |
| `Telegram rejected getUpdates (HTTP 409) ...` | Another process is polling the bot. Stop it and retry. |
| Discovery returns no chats | Say hello in the destination again (updates expire after 24 hours), then retry. |
| `Hosted mode requires a client, or enabled discovery ...` | Run `keygen` before turning off discovery. |
| HTTP `401 Unauthorized` | Wrong or missing key, or a new key used before restarting. |
| Hosted requests rejected by host | Add your domain to `TELEGRAM_MCP_ALLOWED_HOSTS`. |
| `admin-key show` refuses to run | `TELEGRAM_MCP_ADMIN_KEY` is set; read it from your platform instead. |
| Windows MCP client can't start `telegram-notifs-mcp` | Use `node` as the command and `<npm root -g>\telegram-notifications-mcp\dist\cli.js` as the first argument. |
