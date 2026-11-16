import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KEY_PATTERN = /^tnm_[A-Za-z0-9_-]{43}$/;

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function inspectStatePath(filename: string): Promise<boolean> {
  try {
    const info = await lstat(filename);
    if (info.isSymbolicLink()) throw new StateError(`Refusing symbolic-link state path "${filename}".`);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    if (error instanceof StateError) throw error;
    throw new StateError(`Cannot inspect state path "${filename}".`);
  }
}

export async function protectPrivatePath(filename: string, directory = false): Promise<void> {
  try {
    if (process.platform !== "win32") {
      await chmod(filename, directory ? 0o700 : 0o600);
      return;
    }
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; "
        + "$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; "
        + "$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'); "
        + "$isDir = Test-Path -LiteralPath $env:TELEGRAM_NOTIF_ACL_PATH -PathType Container; "
        + "$acl = if ($isDir) { [System.Security.AccessControl.DirectorySecurity]::new() } "
        + "else { [System.Security.AccessControl.FileSecurity]::new() }; "
        + "$inherit = if ($isDir) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } "
        + "else { [System.Security.AccessControl.InheritanceFlags]::None }; "
        + "$acl.SetOwner($user); $acl.SetAccessRuleProtection($true, $false); "
        + "foreach ($sid in @($user, $system)) { "
        + "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new("
        + "$sid, 'FullControl', $inherit, 'None', 'Allow'); $acl.AddAccessRule($rule) }; "
        + "Set-Acl -LiteralPath $env:TELEGRAM_NOTIF_ACL_PATH -AclObject $acl",
    ], { env: { ...process.env, TELEGRAM_NOTIF_ACL_PATH: filename }, windowsHide: true });
  } catch {
    throw new StateError(`Cannot restrict permissions on "${filename}".`);
  }
}

export async function ensureStateDirectory(directory: string, privateDirectory = false): Promise<void> {
  if (await inspectStatePath(directory)) {
    if (!(await lstat(directory)).isDirectory()) throw new StateError(`"${directory}" is not a directory.`);
    if (privateDirectory) await protectPrivatePath(directory, true);
    return;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await protectPrivatePath(directory, true);
}

export async function createPrivateFile(filename: string, contents: string): Promise<boolean> {
  const temporary = `${filename}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await protectPrivatePath(temporary);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    try {
      await link(temporary, filename);
      return true;
    } catch (error) {
      if (hasCode(error, "EEXIST")) {
        await inspectStatePath(filename);
        return false;
      }
      throw new StateError(`Cannot create private file "${filename}".`);
    }
  } finally {
    await handle.close();
    await unlink(temporary);
  }
}

export function adminKeyPath(configPath: string): string {
  return path.join(`${configPath}.secrets`, "admin.key");
}

async function readKeyFile(filename: string): Promise<string | undefined> {
  if (!await inspectStatePath(filename)) return undefined;
  if (!(await lstat(filename)).isFile()) throw new StateError(`"${filename}" is not a regular secret file.`);
  const key = (await readFile(filename, "utf8")).trim();
  if (!KEY_PATTERN.test(key)) throw new StateError(`Invalid administrator secret file "${filename}".`);
  await protectPrivatePath(filename);
  return key;
}

function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function initialManagedKey(
  configPath: string,
  generate: () => { key: string; keySha256: string },
): Promise<{ key: string; keySha256: string }> {
  const filename = adminKeyPath(configPath);
  await ensureStateDirectory(path.dirname(filename), true);
  if (await inspectStatePath(`${filename}.next`)) {
    throw new StateError("An interrupted administrator rotation exists; resolve it before initialization.");
  }
  const existing = await readKeyFile(filename);
  if (existing) return { key: existing, keySha256: keyHash(existing) };
  const generated = generate();
  await createPrivateFile(filename, `${generated.key}\n`);
  const key = await readKeyFile(filename);
  if (!key) throw new StateError("Administrator key persistence failed.");
  return { key, keySha256: keyHash(key) };
}

export async function readManagedKey(
  configPath: string,
  expectedHash: string,
  required = true,
): Promise<string | undefined> {
  const filename = adminKeyPath(configPath);
  if (!await inspectStatePath(path.dirname(filename))) {
    if (!required) return undefined;
    throw new StateError("No managed administrator key exists; use the original key or explicitly rotate it.");
  }
  const key = await readKeyFile(filename);
  if (key && keyHash(key) === expectedHash) return key;
  const pending = await readKeyFile(`${filename}.next`);
  if (pending && keyHash(pending) === expectedHash) {
    await rename(`${filename}.next`, filename);
    return pending;
  }
  throw new StateError("Administrator secret is missing or does not match the configured hash. No key was regenerated.");
}

export async function replaceManagedKey(
  configPath: string,
  key: string,
  saveConfig: () => Promise<void>,
): Promise<void> {
  const filename = adminKeyPath(configPath);
  if (!await createPrivateFile(`${filename}.next`, `${key}\n`)) {
    throw new StateError("An administrator key update is pending; resolve it before rotating again.");
  }
  try {
    await saveConfig();
  } catch (error) {
    await unlink(`${filename}.next`);
    throw error;
  }
  await rename(`${filename}.next`, filename);
}
