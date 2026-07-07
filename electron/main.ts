import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, createWriteStream } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Tray,
  ipcMain,
  type MenuItemConstructorOptions,
} from "electron";

// ── Constants ────────────────────────────────────────────────────────────────
const DEV = !app.isPackaged;
const HOST = "127.0.0.1";
const DEV_PORT = 3877;
const IPC_SECRET_HEADER = "x-jwl-secret";
const STATUS_POLL_MS = 1000;

/** Appends a diagnostic line to userData/main.log (GUI apps have no console). */
function log(message: string): void {
  try {
    appendFileSync(
      join(app.getPath("userData"), "main.log"),
      `[${new Date().toISOString()}] ${message}\n`,
    );
  } catch {
    // Best-effort logging only.
  }
}

// In dev the secret is shared with `next dev` via the environment (set by the
// npm script). In production the main process is the sole owner of the secret.
const SECRET = DEV
  ? (process.env.JWL_IPC_SECRET ?? "dev-secret")
  : randomBytes(24).toString("hex");

// ── Module state ─────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverProcess: ChildProcess | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let appPort = DEV_PORT;
let isQuitting = false;

type TimerStatus =
  | { running: false }
  | { running: true; description: string; effectiveSeconds: number };

let lastStatus: TimerStatus = { running: false };

// ── Paths ────────────────────────────────────────────────────────────────────
function assetsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "assets")
    : join(__dirname, "..", "assets");
}

function trayIcon(running: boolean) {
  const file = running ? "tray-running.png" : "tray-idle.png";
  const img = nativeImage.createFromPath(join(assetsDir(), file));
  img.setTemplateImage(false);
  return img;
}

/** The real on-disk executable, even for the portable (temp-extracted) build. */
function executablePath(): string {
  return process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath;
}

// ── Networking helpers ───────────────────────────────────────────────────────
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, HOST, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function apiRequest(
  method: "GET" | "POST",
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: HOST,
        port: appPort,
        path,
        method,
        headers: { [IPC_SECRET_HEADER]: SECRET },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = httpRequest(
        { host: HOST, port: appPort, path: "/", method: "GET" },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error("Timed out waiting for the app server to start."));
        } else {
          setTimeout(attempt, 300);
        }
      });
      req.end();
    };
    attempt();
  });
}

// ── Embedded Next.js server (production only) ────────────────────────────────
function startServer(): void {
  const serverDir = join(process.resourcesPath, "standalone");
  const serverEntry = join(serverDir, "server.js");
  const migrationsDir = join(process.resourcesPath, "drizzle");
  const dbPath = join(app.getPath("userData"), "jiraworklog.db");
  log(`Spawning server: ${serverEntry}`);

  const logStream = createWriteStream(
    join(app.getPath("userData"), "server.log"),
    { flags: "a" },
  );

  // Start from a clean environment: strip inherited Node flags (e.g. the VS
  // Code debugger's NODE_OPTIONS=--require bootloader) that are invalid for the
  // forked production server and would crash or hang it.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.ELECTRON_RUN_AS_NODE;

  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: serverDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...childEnv,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      HOSTNAME: HOST,
      PORT: String(appPort),
      JWL_DB_PATH: dbPath,
      JWL_MIGRATIONS_DIR: migrationsDir,
      JWL_IPC_SECRET: SECRET,
    },
  });

  serverProcess.stdout?.pipe(logStream);
  serverProcess.stderr?.pipe(logStream);

  serverProcess.on("error", (err) => {
    log(`Server spawn error: ${err.stack ?? String(err)}`);
  });

  serverProcess.on("exit", (code) => {
    log(`Server exited with code ${code}.`);
    serverProcess = null;
    if (!isQuitting) {
      app.quit();
    }
  });
}

// ── Window ───────────────────────────────────────────────────────────────────
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 640,
    show: false,
    icon: join(assetsDir(), "icon.png"),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep the live timer's setInterval ticking while the window is hidden in
      // the tray; Chromium otherwise throttles background timers heavily.
      backgroundThrottling: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.loadURL(`http://${HOST}:${appPort}/`);

  mainWindow.webContents.on(
    "console-message",
    (_e, level, message, line, sourceId) => {
      // Only surface warnings/errors to keep the log readable.
      if (level >= 2) {
        log(`renderer [${level}] ${message} (${sourceId}:${line})`);
      }
    },
  );
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    log(`renderer did-fail-load ${code} ${desc} ${url}`);
  });

  // Closing the window hides to tray instead of quitting; the timer keeps
  // running. A real quit only happens via the tray's "Beenden" action.
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ── Tray ─────────────────────────────────────────────────────────────────────
function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

function buildTrayMenu(): void {
  if (!tray) return;

  const running = lastStatus.running;
  const label = running
    ? `▶ ${formatElapsed(lastStatus.effectiveSeconds)} — ${
        lastStatus.description?.trim() || "Ohne Beschreibung"
      }`
    : "Kein laufender Timer";

  const template: MenuItemConstructorOptions[] = [
    { label, enabled: false },
    { type: "separator" },
    {
      label: "Timer stoppen",
      enabled: running,
      click: () => void stopTimerFromTray(),
    },
    {
      label: mainWindow?.isVisible()
        ? "Fenster ausblenden"
        : "Fenster anzeigen",
      click: () => {
        if (mainWindow?.isVisible()) {
          mainWindow.hide();
        } else {
          showWindow();
        }
      },
    },
    { type: "separator" },
    {
      label: "Beenden",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(
    running
      ? `JiraWorklog — läuft ${formatElapsed(lastStatus.effectiveSeconds)}`
      : "JiraWorklog — kein laufender Timer",
  );
  tray.setImage(trayIcon(running));
}

function createTray(): void {
  tray = new Tray(trayIcon(false));
  tray.on("click", () => showWindow());
  buildTrayMenu();
}

async function refreshStatus(): Promise<void> {
  try {
    const res = await apiRequest("GET", "/api/timer/status");
    if (res.status === 200) {
      lastStatus = JSON.parse(res.body) as TimerStatus;
    }
  } catch {
    // Server not ready yet or transient error — keep the last known status.
  }
  buildTrayMenu();
}

async function stopTimerFromTray(): Promise<void> {
  try {
    const res = await apiRequest("POST", "/api/timer/stop");
    if (res.status === 200) {
      lastStatus = { running: false };
      buildTrayMenu();
      mainWindow?.webContents.send("timer-stopped");
    }
  } catch {
    // Ignore — the next poll will reconcile the tray state.
  }
}

// ── Auto-launch (Windows login item) ─────────────────────────────────────────
function getAutoLaunch(): boolean {
  return app.getLoginItemSettings({ path: executablePath() }).openAtLogin;
}

function setAutoLaunch(enabled: boolean): boolean {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: executablePath(),
    args: [],
  });
  return getAutoLaunch();
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(async () => {
    try {
      log(
        `Ready. packaged=${app.isPackaged} resources=${process.resourcesPath}`,
      );
      ipcMain.handle("auto-launch:get", () => getAutoLaunch());
      ipcMain.handle("auto-launch:set", (_e, enabled: boolean) =>
        setAutoLaunch(Boolean(enabled)),
      );

      appPort = DEV ? DEV_PORT : await findFreePort();
      log(`Using port ${appPort}`);

      if (!DEV) startServer();
      log("Waiting for server…");
      await waitForServer();
      log("Server ready.");

      createWindow();
      createTray();

      pollTimer = setInterval(() => void refreshStatus(), STATUS_POLL_MS);
      void refreshStatus();
    } catch (err) {
      log(`Startup failed: ${err instanceof Error ? err.stack : String(err)}`);
    }
  });

  app.on("window-all-closed", () => {
    // Intentionally do nothing: the app lives in the tray until "Beenden".
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });

  app.on("will-quit", () => {
    if (pollTimer) clearInterval(pollTimer);
    serverProcess?.kill();
  });
}
