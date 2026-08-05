import { contextBridge, ipcRenderer } from 'electron'
import type { VideoInfo } from '../main/ffmpeg'
import type { TrimJob, TrimTask } from '../main/index'

export interface TrimEventMap {
  start: { ev: 'start'; total: number }
  end: { ev: 'end'; done: number; failed: number; cancelled: boolean }
  task: { ev: 'task' } & TrimTask
}

export type TrimEvent = TrimEventMap[keyof TrimEventMap]

const api = {
  openVideos: (): Promise<string[]> => ipcRenderer.invoke('dialog:openVideos'),
  probeVideo: (filePath: string): Promise<VideoInfo> => ipcRenderer.invoke('video:probe', filePath),
  generateThumbnails: (filePath: string, count: number): Promise<{ id: string; urls: string[] }> =>
    ipcRenderer.invoke('video:thumbs', filePath, count),
  frameImage: (filePath: string, frameIndex: number): Promise<{ id: string; url: string }> =>
    ipcRenderer.invoke('video:frameImage', filePath, frameIndex),
  trimStart: (jobs: TrimJob[]): Promise<{ started: boolean; reason?: string }> =>
    ipcRenderer.invoke('video:trimStart', jobs),
  trimCancel: (): Promise<boolean> => ipcRenderer.invoke('video:trimCancel'),
  revealInFolder: (filePath: string): Promise<boolean> => ipcRenderer.invoke('video:reveal', filePath),
  onTrimEvent: (callback: (event: TrimEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: TrimEvent): void => callback(data)
    ipcRenderer.on('trim:event', listener)
    return () => ipcRenderer.removeListener('trim:event', listener)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
