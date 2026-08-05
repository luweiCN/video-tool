"use strict";
const electron = require("electron");
const node_path = require("node:path");
const node_url = require("node:url");
const node_child_process = require("node:child_process");
const node_util = require("node:util");
const node_module = require("node:module");
const node_fs = require("node:fs");
const node_crypto = require("node:crypto");
const require$1 = node_module.createRequire(node_path.join(__dirname, ".."));
function resolveBinary(name) {
  try {
    const mod = require$1(name === "ffmpeg" ? "ffmpeg-static" : "ffprobe-static");
    let p;
    if (typeof mod === "string") {
      p = mod;
    } else if (mod) {
      p = mod.path ?? mod.default;
    }
    if (p && node_fs.existsSync(p)) return p;
  } catch {
  }
  return name;
}
function parseFps(rate) {
  if (!rate) return 0;
  const [n, d] = rate.split("/");
  const v = Number(n) / (Number(d) || 1);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
const execFileAsync = node_util.promisify(node_child_process.execFile);
async function probeVideo(filePath) {
  const { stdout } = await execFileAsync(
    resolveBinary("ffprobe"),
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
    { timeout: 6e4 }
  );
  const data = JSON.parse(stdout);
  const vs = data.streams?.find((s) => s.codec_type === "video");
  const as = data.streams?.find((s) => s.codec_type === "audio");
  return {
    duration: Number(data.format?.duration ?? vs?.duration ?? 0),
    width: vs?.width ?? 0,
    height: vs?.height ?? 0,
    fps: parseFps(vs?.avg_frame_rate || vs?.r_frame_rate),
    videoCodec: vs?.codec_name ?? "unknown",
    audioCodec: as?.codec_name ?? null,
    size: node_fs.existsSync(filePath) ? node_fs.statSync(filePath).size : 0
  };
}
const MAX_PREVIEW_FRAMES = 200;
function thumbRoot() {
  return node_path.join(electron.app.getPath("temp"), "video-trimmer-thumbs");
}
async function generateThumbnails(filePath, count) {
  const id = node_crypto.randomUUID();
  const outDir = node_path.join(thumbRoot(), id);
  node_fs.mkdirSync(outDir, { recursive: true });
  const frames = Math.max(1, Math.min(count, MAX_PREVIEW_FRAMES));
  const res = await runFfmpeg(
    ["-y", "-i", filePath, "-frames:v", String(frames), "-vf", "scale=360:-2", "-q:v", "3", node_path.join(outDir, "frame_%03d.jpg")],
    void 0
  );
  if (res.code !== 0) throw new Error(`生成预览失败: ${tail(res.stderr)}`);
  const files = node_fs.readdirSync(outDir).filter((f) => f.endsWith(".jpg")).sort();
  return { id, urls: files.map((f) => `thumb://${id}/${f}`) };
}
function thumbFileFor(id, fileName) {
  return node_path.join(thumbRoot(), id, node_path.basename(fileName));
}
async function generateFrameImage(filePath, frameIndex) {
  const id = node_crypto.randomUUID();
  const outDir = node_path.join(thumbRoot(), id);
  node_fs.mkdirSync(outDir, { recursive: true });
  const outPath = node_path.join(outDir, "frame.jpg");
  const res = await runFfmpeg(
    [
      "-y",
      "-i",
      filePath,
      "-vf",
      `select=eq(n\\,${frameIndex}),scale=w=min(1600\\,iw):h=-2`,
      "-frames:v",
      "1",
      "-q:v",
      "1",
      outPath
    ],
    void 0
  );
  if (res.code !== 0 || !node_fs.existsSync(outPath) || node_fs.statSync(outPath).size === 0) {
    throw new Error(`提取帧失败: ${tail(res.stderr)}`);
  }
  return { id, url: `thumb://${id}/frame.jpg` };
}
function clearThumbRoot() {
  try {
    node_fs.rmSync(thumbRoot(), { recursive: true, force: true });
  } catch {
  }
}
let currentProc = null;
function cancelCurrent() {
  currentProc?.kill();
}
function buildTrimArgs(input, output, seconds, reencode) {
  const codec = reencode ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "160k"] : ["-c", "copy"];
  if (reencode) {
    return [
      "-y",
      "-i",
      input,
      "-ss",
      seconds.toFixed(3),
      ...codec,
      "-avoid_negative_ts",
      "make_zero",
      "-movflags",
      "+faststart",
      "-map",
      "0",
      "-map_metadata",
      "0",
      output
    ];
  }
  return [
    "-y",
    "-ss",
    seconds.toFixed(3),
    "-i",
    input,
    ...codec,
    "-avoid_negative_ts",
    "make_zero",
    "-movflags",
    "+faststart",
    "-map",
    "0",
    "-map_metadata",
    "0",
    output
  ];
}
function runFfmpeg(args, onProgress) {
  return new Promise((resolve) => {
    const proc = node_child_process.spawn(resolveBinary("ffmpeg"), args);
    currentProc = proc;
    let stderr = "";
    proc.stdout?.on("data", (d) => {
      if (!onProgress) return;
      const m = d.toString().match(/out_time_ms=(\d+)/);
      if (m) onProgress(Number(m[1]) / 1e6);
    });
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (err) => {
      if (currentProc === proc) currentProc = null;
      resolve({ code: -1, stderr: String(err.message ?? err) });
    });
    proc.on("close", (code) => {
      if (currentProc === proc) currentProc = null;
      resolve({ code: code ?? -1, stderr });
    });
  });
}
function tail(s, n = 8) {
  return s.split("\n").filter(Boolean).slice(-n).join("\n");
}
async function probeKeyframes(filePath) {
  const { stdout } = await execFileAsync(
    resolveBinary("ffprobe"),
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_packets",
      "-show_entries",
      "packet=pts_time,flags",
      "-of",
      "csv=p=0",
      filePath
    ],
    { timeout: 6e4, maxBuffer: 20 * 1024 * 1024 }
  );
  const pts = [];
  for (const line of stdout.split("\n")) {
    const [tStr, flags] = line.split(",");
    if (!flags?.startsWith("K")) continue;
    const t = Number(tStr);
    if (Number.isFinite(t) && t > 1e-3) pts.push(t);
  }
  return pts;
}
async function computeCutPoint(filePath, targetSec) {
  const keys = await probeKeyframes(filePath);
  const after = keys.find((k) => k >= targetSec - 1e-3);
  if (after !== void 0) return { seconds: after, aligned: true };
  return { seconds: targetSec, aligned: false };
}
async function trimVideo(input, seconds, duration, onProgress) {
  const outDir = node_path.join(node_path.dirname(input), "_trimmed");
  node_fs.mkdirSync(outDir, { recursive: true });
  const outPath = node_path.join(outDir, node_path.basename(input));
  const cut = await computeCutPoint(input, seconds);
  const total = Math.max(0.1, duration - cut.seconds);
  let lastError = "";
  const attempt = async (reencode, cutAt) => {
    const { code, stderr } = await runFfmpeg(
      buildTrimArgs(input, outPath, cutAt, reencode),
      (sec) => onProgress?.(Math.min(1, sec / total))
    );
    const valid = code === 0 && node_fs.existsSync(outPath) && node_fs.statSync(outPath).size > 0;
    if (!valid) {
      node_fs.rmSync(outPath, { force: true });
      lastError = code === 0 ? "输出文件为空或无效" : tail(stderr);
    }
    return valid;
  };
  if (cut.aligned) {
    const copyOk = await attempt(false, cut.seconds);
    if (copyOk) return { ok: true, outPath, reencoded: false, cutSeconds: cut.seconds };
    const reencodeOk = await attempt(true, seconds);
    if (reencodeOk) return { ok: true, outPath, reencoded: true, cutSeconds: seconds };
  } else {
    const reencodeOk = await attempt(true, seconds);
    if (reencodeOk) return { ok: true, outPath, reencoded: true, cutSeconds: seconds };
  }
  return { ok: false, outPath: "", reencoded: false, cutSeconds: 0, error: lastError };
}
const VIDEO_FILTERS = [
  {
    name: "视频文件",
    extensions: ["mp4", "mov", "mkv", "avi", "wmv", "flv", "webm", "ts", "m4v", "mpg", "mpeg"]
  }
];
let session = null;
function sendSessionEvent(win, ev, payload) {
  if (!win.isDestroyed()) win.webContents.send("trim:event", { ev, ...payload });
}
function sessionTask(win, filePath) {
  const s = session;
  const task = s?.tasks.find((t) => t.filePath === filePath);
  if (task) return task;
  const created = { filePath, status: "pending", progress: 0 };
  s?.tasks.push(created);
  sendSessionEvent(win, "task", created);
  return created;
}
async function runSession(win, jobs) {
  const s = session;
  sendSessionEvent(win, "start", { total: jobs.length });
  for (const job of jobs) {
    if (s.cancelRequested) break;
    const task = sessionTask(win, job.filePath);
    task.status = "running";
    task.progress = 0;
    sendSessionEvent(win, "task", { ...task });
    const result = await trimVideo(job.filePath, job.seconds, job.duration, (ratio) => {
      task.progress = ratio;
      sendSessionEvent(win, "task", { ...task });
    });
    task.status = result.ok ? "done" : "error";
    task.progress = result.ok ? 1 : task.progress;
    task.outPath = result.outPath;
    task.reencoded = result.reencoded;
    task.cutSeconds = result.cutSeconds;
    task.error = result.error;
    sendSessionEvent(win, "task", { ...task });
  }
  const done = s.tasks.filter((t) => t.status === "done").length;
  const failed = s.tasks.filter((t) => t.status === "error").length;
  sendSessionEvent(win, "end", { done, failed, cancelled: s.cancelRequested });
  s.running = false;
  session = null;
}
function createWindow() {
  const win = new electron.BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: "视频开头帧移除工具",
    backgroundColor: "#1b1e24",
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (!electron.app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(node_path.join(__dirname, "../renderer/index.html"));
  }
  return win;
}
electron.app.on("will-quit", () => {
  clearThumbRoot();
});
electron.app.whenReady().then(() => {
  electron.protocol.handle("thumb", (request) => {
    const url = new URL(request.url);
    const fileName = node_path.basename(url.pathname);
    const full = thumbFileFor(url.hostname, fileName);
    return electron.net.fetch(node_url.pathToFileURL(full).toString());
  });
  const win = createWindow();
  electron.ipcMain.handle("dialog:openVideos", async () => {
    const res = await electron.dialog.showOpenDialog(win, {
      title: "选择视频文件",
      properties: ["openFile", "multiSelections"],
      filters: [VIDEO_FILTERS[0]]
    });
    return res.canceled ? [] : res.filePaths;
  });
  electron.ipcMain.handle("video:probe", async (_e, filePath) => {
    return probeVideo(filePath);
  });
  electron.ipcMain.handle("video:thumbs", async (_e, filePath, count) => {
    return generateThumbnails(filePath, count);
  });
  electron.ipcMain.handle("video:frameImage", async (_e, filePath, frameIndex) => {
    return generateFrameImage(filePath, frameIndex);
  });
  electron.ipcMain.handle("video:trimStart", async (_e, jobs) => {
    if (session?.running) return { started: false, reason: "busy" };
    const tasks = jobs.map((j) => ({ filePath: j.filePath, status: "pending", progress: 0 }));
    session = { win, tasks, running: true, cancelRequested: false };
    for (const t of tasks) sendSessionEvent(win, "task", t);
    runSession(win, jobs);
    return { started: true };
  });
  electron.ipcMain.handle("video:trimCancel", async () => {
    if (session) {
      session.cancelRequested = true;
      cancelCurrent();
    }
    return true;
  });
  electron.ipcMain.handle("video:reveal", async (_e, filePath) => {
    electron.shell.showItemInFolder(filePath);
    return true;
  });
  win.on("closed", () => {
    cancelCurrent();
  });
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
