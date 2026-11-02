// Windows desktop shell for the ERP. Loads the live app; the app's offline
// service worker + on-device storage keep POS, kisti, expenses and stock views
// working without internet, and sync automatically when the connection returns.
const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("path");

const APP_URL = process.env.ERP_URL || "https://stock-showroom.lovable.app/dashboard";

function offlinePage() {
  return "data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><html><body style="font-family:Segoe UI,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f7f5f0;color:#123">
  <div style="text-align:center;max-width:420px"><h2>No internet yet</h2>
  <p>Open the app once while online on this computer so it can be saved for offline use.</p>
  <button onclick="location.href='${APP_URL}'" style="padding:10px 18px;border:0;border-radius:8px;background:#04605d;color:#fff;font-size:15px">Try again</button></div></body></html>`);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1366, height: 860, minWidth: 360,
    title: "Dealer ERP",
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: "#f7f5f0",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, partition: "persist:erp", spellcheck: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(new URL(APP_URL).origin)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-fail-load", (_e, code, _d, url, isMain) => {
    if (isMain && code !== -3 && !url.startsWith("data:")) win.loadURL(offlinePage());
  });
  win.loadURL(APP_URL);
}

Menu.setApplicationMenu(null);
app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
