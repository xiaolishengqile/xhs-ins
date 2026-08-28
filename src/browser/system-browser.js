import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SYSTEM_BROWSER_LAUNCH_OPTIONS = [{ channel: "chrome" }, { channel: "msedge" }];
const WINDOWS_HTTPS_USER_CHOICE =
  "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";

function registryString(stdout) {
  return stdout.match(/REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim() ?? "";
}

async function readWindowsDefaultBrowser() {
  const { stdout: userChoice } = await execFileAsync("reg.exe", ["query", WINDOWS_HTTPS_USER_CHOICE, "/v", "ProgId"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const browserId = registryString(userChoice);
  if (!browserId) return { browserId: "", command: "" };
  const { stdout: openCommand } = await execFileAsync(
    "reg.exe",
    ["query", `HKCR\\${browserId}\\shell\\open\\command`, "/ve"],
    { encoding: "utf8", windowsHide: true },
  );
  return { browserId, command: registryString(openCommand) };
}

function channelForBrowserId(browserId) {
  if (/ChromeHTML/i.test(browserId)) return "chrome";
  if (/MSEdgeHTM/i.test(browserId)) return "msedge";
  return null;
}

function executablePathFromCommand(command) {
  const value = command.trim();
  const executablePath = value.match(/^"([^"]+\.exe)"/i)?.[1] ?? value.match(/^(\S+\.exe)\b/i)?.[1];
  return executablePath && path.win32.isAbsolute(executablePath) ? executablePath : null;
}

export async function resolveSystemBrowserLaunchOptions({
  platform = process.platform,
  readDefaultBrowser = readWindowsDefaultBrowser,
} = {}) {
  const fallbacks = SYSTEM_BROWSER_LAUNCH_OPTIONS.map((options) => ({ ...options }));
  if (platform !== "win32") return fallbacks;

  let defaultBrowser;
  try {
    defaultBrowser = await readDefaultBrowser();
  } catch {
    return fallbacks;
  }
  const preferredChannel = channelForBrowserId(defaultBrowser.browserId);
  if (preferredChannel) {
    return [
      { channel: preferredChannel },
      ...fallbacks.filter((options) => options.channel !== preferredChannel),
    ];
  }
  const executablePath = executablePathFromCommand(defaultBrowser.command);
  return executablePath ? [{ executablePath }, ...fallbacks] : fallbacks;
}
