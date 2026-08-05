import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { join, dirname, basename } from 'node:path'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'

const require = createRequire(join(__dirname, '..'))

export function resolveBinary(name: 'ffmpeg' | 'ffprobe'): string {
  if (app.isPackaged) {
    const exe = process.platform === 'win32' ? '.exe' : ''
    return join(process.resourcesPath, 'bin', `${name}${exe}`)
  }
  try {
    const mod = require(name === 'ffmpeg' ? 'ffmpeg-static' : 'ffprobe-static')
    let p: string | undefined
    if (typeof mod === 'string') {
      p = mod
    } else if (mod) {
      p = (mod as { path?: string }).path ?? (mod as { default?: string }).default
    }
    if (p && existsSync(p)) return p
  } catch {
    // ignore, fall through
  }
  return name
}

export interface VideoInfo {
  duration: number
  width: number
  height: number
  fps: number
  videoCodec: string
  audioCodec: string | null
  size: number
}

export function parseFps(rate?: string): number {
  if (!rate) return 0
  const [n, d] = rate.split('/')
  const v = Number(n) / (Number(d) || 1)
  return Number.isFinite(v) && v > 0 ? v : 0
}

const execFileAsync = promisify(execFile)

export async function probeVideo(filePath: string): Promise<VideoInfo> {
  const { stdout } = await execFileAsync(
    resolveBinary('ffprobe'),
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeout: 60000 }
  )
  const data = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: Array<{
      codec_type?: string
      codec_name?: string
      width?: number
      height?: number
      avg_frame_rate?: string
      r_frame_rate?: string
      duration?: string
    }>
  }
  const vs = data.streams?.find((s) => s.codec_type === 'video')
  const as = data.streams?.find((s) => s.codec_type === 'audio')
  return {
    duration: Number(data.format?.duration ?? vs?.duration ?? 0),
    width: vs?.width ?? 0,
    height: vs?.height ?? 0,
    fps: parseFps(vs?.avg_frame_rate || vs?.r_frame_rate),
    videoCodec: vs?.codec_name ?? 'unknown',
    audioCodec: as?.codec_name ?? null,
    size: existsSync(filePath) ? statSync(filePath).size : 0
  }
}

export const MAX_PREVIEW_FRAMES = 200

function thumbRoot(): string {
  return join(app.getPath('temp'), 'video-trimmer-thumbs')
}

export async function generateThumbnails(
  filePath: string,
  count: number
): Promise<{ id: string; urls: string[] }> {
  const id = randomUUID()
  const outDir = join(thumbRoot(), id)
  mkdirSync(outDir, { recursive: true })
  const frames = Math.max(1, Math.min(count, MAX_PREVIEW_FRAMES))
  const res = await runFfmpeg(
    ['-y', '-i', filePath, '-frames:v', String(frames), '-vf', 'scale=360:-2', '-q:v', '3', join(outDir, 'frame_%03d.jpg')],
    undefined
  )
  if (res.code !== 0) throw new Error(`生成预览失败: ${tail(res.stderr)}`)
  const files = readdirSync(outDir)
    .filter((f) => f.endsWith('.jpg'))
    .sort()
  return { id, urls: files.map((f) => `thumb://${id}/${f}`) }
}

export function thumbFileFor(id: string, fileName: string): string {
  return join(thumbRoot(), id, basename(fileName))
}

export async function generateFrameImage(
  filePath: string,
  frameIndex: number
): Promise<{ id: string; url: string }> {
  const id = randomUUID()
  const outDir = join(thumbRoot(), id)
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, 'frame.jpg')
  const res = await runFfmpeg(
    [
      '-y',
      '-i', filePath,
      '-vf', `select=eq(n\\,${frameIndex}),scale=w=min(1600\\,iw):h=-2`,
      '-frames:v', '1',
      '-q:v', '1',
      outPath
    ],
    undefined
  )
  if (res.code !== 0 || !existsSync(outPath) || statSync(outPath).size === 0) {
    throw new Error(`提取帧失败: ${tail(res.stderr)}`)
  }
  return { id, url: `thumb://${id}/frame.jpg` }
}

export function clearThumbRoot(): void {
  try {
    rmSync(thumbRoot(), { recursive: true, force: true })
  } catch {
    // ignore
  }
}

let currentProc: ChildProcess | null = null

export function cancelCurrent(): void {
  currentProc?.kill()
}

export function buildTrimArgs(input: string, output: string, seconds: number, reencode: boolean): string[] {
  const codec = reencode
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k']
    : ['-c', 'copy']
  if (reencode) {
    // 重编码：输出端 -ss 帧级精确
    return [
      '-y',
      '-i', input,
      '-ss', seconds.toFixed(3),
      ...codec,
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-map', '0',
      '-map_metadata', '0',
      output
    ]
  }
  // 流拷贝：输入端 -ss 对齐到目标时间之后最近的关键帧
  return [
    '-y',
    '-ss', seconds.toFixed(3),
    '-i', input,
    ...codec,
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    '-map', '0',
    '-map_metadata', '0',
    output
  ]
}

function runFfmpeg(
  args: string[],
  onProgress: ((sec: number) => void) | undefined
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(resolveBinary('ffmpeg'), args)
    currentProc = proc
    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => {
      if (!onProgress) return
      const m = d.toString().match(/out_time_ms=(\d+)/)
      if (m) onProgress(Number(m[1]) / 1e6)
    })
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('error', (err) => {
      if (currentProc === proc) currentProc = null
      resolve({ code: -1, stderr: String(err.message ?? err) })
    })
    proc.on('close', (code) => {
      if (currentProc === proc) currentProc = null
      resolve({ code: code ?? -1, stderr })
    })
  })
}

function tail(s: string, n = 8): string {
  return s
    .split('\n')
    .filter(Boolean)
    .slice(-n)
    .join('\n')
}

export async function probeKeyframes(filePath: string): Promise<number[]> {
  const { stdout } = await execFileAsync(
    resolveBinary('ffprobe'),
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_packets',
      '-show_entries', 'packet=pts_time,flags',
      '-of', 'csv=p=0',
      filePath
    ],
    { timeout: 60000, maxBuffer: 20 * 1024 * 1024 }
  )
  const pts: number[] = []
  for (const line of stdout.split('\n')) {
    const [tStr, flags] = line.split(',')
    if (!flags?.startsWith('K')) continue
    const t = Number(tStr)
    if (Number.isFinite(t) && t > 0.001) pts.push(t)
  }
  return pts
}

export async function computeCutPoint(
  filePath: string,
  targetSec: number
): Promise<{ seconds: number; aligned: boolean }> {
  const keys = await probeKeyframes(filePath)
  const after = keys.find((k) => k >= targetSec - 0.001)
  if (after !== undefined) return { seconds: after, aligned: true }
  return { seconds: targetSec, aligned: false }
}

export interface TrimResult {
  ok: boolean
  outPath: string
  reencoded: boolean
  cutSeconds: number
  error?: string
}

export async function trimVideo(
  input: string,
  seconds: number,
  duration: number,
  onProgress?: (ratio: number) => void
): Promise<TrimResult> {
  const outDir = join(dirname(input), '_trimmed')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, basename(input))
  const cut = await computeCutPoint(input, seconds)
  const total = Math.max(0.1, duration - cut.seconds)
  let lastError = ''

  const attempt = async (reencode: boolean, cutAt: number) => {
    const { code, stderr } = await runFfmpeg(
      buildTrimArgs(input, outPath, cutAt, reencode),
      (sec) => onProgress?.(Math.min(1, sec / total))
    )
    const valid = code === 0 && existsSync(outPath) && statSync(outPath).size > 0
    if (!valid) {
      rmSync(outPath, { force: true })
      lastError = code === 0 ? '输出文件为空或无效' : tail(stderr)
    }
    return valid
  }

  if (cut.aligned) {
    const copyOk = await attempt(false, cut.seconds)
    if (copyOk) return { ok: true, outPath, reencoded: false, cutSeconds: cut.seconds }
    const reencodeOk = await attempt(true, seconds)
    if (reencodeOk) return { ok: true, outPath, reencoded: true, cutSeconds: seconds }
  } else {
    const reencodeOk = await attempt(true, seconds)
    if (reencodeOk) return { ok: true, outPath, reencoded: true, cutSeconds: seconds }
  }
  return { ok: false, outPath: '', reencoded: false, cutSeconds: 0, error: lastError }
}
