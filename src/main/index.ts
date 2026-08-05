import { app, shell, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  probeVideo,
  generateThumbnails,
  generateFrameImage,
  trimVideo,
  thumbFileFor,
  clearThumbRoot,
  cancelCurrent,
  type VideoInfo
} from './ffmpeg'

const VIDEO_FILTERS = [
  {
    name: '视频文件',
    extensions: ['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'ts', 'm4v', 'mpg', 'mpeg']
  }
]

export interface TrimJob {
  filePath: string
  seconds: number
  duration: number
}

export interface TrimTask {
  filePath: string
  status: 'pending' | 'running' | 'done' | 'error'
  progress: number
  outPath?: string
  reencoded?: boolean
  cutSeconds?: number
  error?: string
}

interface ActiveSession {
  win: BrowserWindow
  tasks: TrimTask[]
  running: boolean
  cancelRequested: boolean
}

let session: ActiveSession | null = null

function sendSessionEvent(win: BrowserWindow, ev: string, payload: object): void {
  if (!win.isDestroyed()) win.webContents.send('trim:event', { ev, ...payload })
}

function sessionTask(win: BrowserWindow, filePath: string): TrimTask {
  const s = session
  const task = s?.tasks.find((t) => t.filePath === filePath)
  if (task) return task
  const created: TrimTask = { filePath, status: 'pending', progress: 0 }
  s?.tasks.push(created)
  sendSessionEvent(win, 'task', created)
  return created
}

async function runSession(win: BrowserWindow, jobs: TrimJob[]): Promise<void> {
  const s = session!
  sendSessionEvent(win, 'start', { total: jobs.length })
  for (const job of jobs) {
    if (s.cancelRequested) break
    const task = sessionTask(win, job.filePath)
    task.status = 'running'
    task.progress = 0
    sendSessionEvent(win, 'task', { ...task })
    const result = await trimVideo(job.filePath, job.seconds, job.duration, (ratio) => {
      task.progress = ratio
      sendSessionEvent(win, 'task', { ...task })
    })
    task.status = result.ok ? 'done' : 'error'
    task.progress = result.ok ? 1 : task.progress
    task.outPath = result.outPath
    task.reencoded = result.reencoded
    task.cutSeconds = result.cutSeconds
    task.error = result.error
    sendSessionEvent(win, 'task', { ...task })
  }
  const done = s.tasks.filter((t) => t.status === 'done').length
  const failed = s.tasks.filter((t) => t.status === 'error').length
  sendSessionEvent(win, 'end', { done, failed, cancelled: s.cancelRequested })
  s.running = false
  session = null
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: '视频开头帧移除工具',
    backgroundColor: '#1b1e24',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

app.on('will-quit', () => {
  clearThumbRoot()
})

app.whenReady().then(() => {
  protocol.handle('thumb', (request) => {
    const url = new URL(request.url)
    const fileName = basename(url.pathname)
    const full = thumbFileFor(url.hostname, fileName)
    return net.fetch(pathToFileURL(full).toString())
  })

  const win = createWindow()

  ipcMain.handle('dialog:openVideos', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择视频文件',
      properties: ['openFile', 'multiSelections'],
      filters: [VIDEO_FILTERS[0]]
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('video:probe', async (_e, filePath: string): Promise<VideoInfo> => {
    return probeVideo(filePath)
  })

  ipcMain.handle('video:thumbs', async (_e, filePath: string, count: number) => {
    return generateThumbnails(filePath, count)
  })

  ipcMain.handle('video:frameImage', async (_e, filePath: string, frameIndex: number) => {
    return generateFrameImage(filePath, frameIndex)
  })

  ipcMain.handle('video:trimStart', async (_e, jobs: TrimJob[]) => {
    if (session?.running) return { started: false, reason: 'busy' }
    const tasks: TrimTask[] = jobs.map((j) => ({ filePath: j.filePath, status: 'pending' as const, progress: 0 }))
    session = { win, tasks, running: true, cancelRequested: false }
    for (const t of tasks) sendSessionEvent(win, 'task', t)
    runSession(win, jobs)
    return { started: true }
  })

  ipcMain.handle('video:trimCancel', async () => {
    if (session) {
      session.cancelRequested = true
      cancelCurrent()
    }
    return true
  })

  ipcMain.handle('video:reveal', async (_e, filePath: string) => {
    shell.showItemInFolder(filePath)
    return true
  })

  win.on('closed', () => {
    cancelCurrent()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
