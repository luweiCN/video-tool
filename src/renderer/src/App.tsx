import { useCallback, useEffect, useMemo, useState } from 'react'
import type { VideoInfo } from '../../main/ffmpeg'
import type { TrimTask } from '../../main/index'
import type { TrimEvent } from '../../preload/index'

interface ThumbCache {
  id: string
  urls: string[]
  count: number
}

interface FileEntry {
  path: string
  name: string
  info?: VideoInfo
  probeError?: string
  task?: TrimTask
  thumbs?: ThumbCache
}

const MAX_PREVIEW = 200

function baseName(p: string): string {
  return p.replace(/^.*[\\/]/, '')
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB'
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return bytes + ' B'
}

function fmtDuration(s: number): string {
  if (!s || !isFinite(s)) return '—'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return m > 0 ? `${m}分${sec}秒` : `${sec}秒`
}

function statusLabel(task?: TrimTask): { text: string; cls: string } | null {
  if (!task) return null
  switch (task.status) {
    case 'pending':
      return { text: '等待中', cls: 'st-pending' }
    case 'running':
      return { text: `处理中 ${Math.round(task.progress * 100)}%`, cls: 'st-running' }
    case 'done':
      return {
        text: task.cutSeconds ? `完成 · 切除${task.cutSeconds.toFixed(1)}s${task.reencoded ? '(重编码)' : ''}` : '完成',
        cls: 'st-done'
      }
    case 'error':
      return { text: '失败', cls: 'st-error' }
  }
}

interface ZoomState {
  index: number
  url?: string
  loading: boolean
  error?: string
}

function App(): React.JSX.Element {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [framesToRemove, setFramesToRemove] = useState(20)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const [summary, setSummary] = useState<string>('')
  const [zoom, setZoom] = useState<ZoomState | null>(null)

  const selected = useMemo(() => files.find((f) => f.path === selectedPath), [files, selectedPath])

  const addFiles = useCallback(async () => {
    const paths = await window.api.openVideos()
    if (!paths.length) return
    const existing = new Set(files.map((f) => f.path))
    const fresh = paths.filter((p) => !existing.has(p))
    if (!fresh.length) return
    const entries = await Promise.all(
      fresh.map(async (p): Promise<FileEntry> => {
        try {
          const info = await window.api.probeVideo(p)
          return { path: p, name: baseName(p), info }
        } catch (e) {
          return { path: p, name: baseName(p), probeError: String(e) }
        }
      })
    )
    setFiles((prev) => [...prev, ...entries])
    if (!selectedPath && entries.length) setSelectedPath(entries[0].path)
  }, [files, selectedPath])

  const removeFile = useCallback(
    (path: string) => {
      setFiles((prev) => prev.filter((f) => f.path !== path))
      if (selectedPath === path) setSelectedPath(null)
    },
    [selectedPath]
  )

  const loadThumbs = useCallback(
    async (f: FileEntry, count: number) => {
      if (!f.info || f.probeError) return
      const clamped = Math.min(Math.max(1, count), MAX_PREVIEW)
      if (f.thumbs?.count === clamped) return
      const res = await window.api.generateThumbnails(f.path, clamped)
      setFiles((prev) => prev.map((x) => (x.path === f.path ? { ...x, thumbs: { ...res, count: clamped } } : x)))
    },
    []
  )

  useEffect(() => {
    if (selected && !processing) {
      void loadThumbs(selected, framesToRemove)
    }
  }, [selected, framesToRemove, processing, loadThumbs])

  useEffect(() => {
    const off = window.api.onTrimEvent((ev: TrimEvent) => {
      if (ev.ev === 'task') {
        setFiles((prev) => prev.map((f) => (f.path === ev.filePath ? { ...f, task: ev } : f)))
      } else if (ev.ev === 'start') {
        setProcessing(true)
        setSummary('')
      } else if (ev.ev === 'end') {
        setProcessing(false)
        setSummary(`处理完成：成功 ${ev.done} 个，失败 ${ev.failed} 个${ev.cancelled ? '（已取消）' : ''}`)
      }
    })
    return off
  }, [])

  const startTrim = useCallback(async () => {
    if (processing) return
    const jobs = files
      .filter((f) => f.info && !f.probeError && f.task?.status !== 'done' && f.task?.status !== 'running')
      .map((f) => ({
        filePath: f.path,
        seconds: framesToRemove / (f.info!.fps || 30),
        duration: f.info!.duration
      }))
    if (!jobs.length) return
    setSummary(`开始处理 ${jobs.length} 个文件…`)
    await window.api.trimStart(jobs)
  }, [files, framesToRemove, processing])

  const cancelTrim = useCallback(async () => {
    await window.api.trimCancel()
  }, [])

  const openZoom = useCallback(
    async (index: number) => {
      if (!selected) return
      setZoom({ index, loading: true })
      try {
        const res = await window.api.frameImage(selected.path, index)
        setZoom({ index, url: res.url, loading: false })
      } catch (e) {
        setZoom({ index, loading: false, error: String(e) })
      }
    },
    [selected]
  )

  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setZoom(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom])

  const runningTask = files.find((f) => f.task?.status === 'running')?.task
  const overall = runningTask ? Math.round(runningTask.progress * 100) : 0
  const secondsText = selected?.info
    ? (framesToRemove / (selected.info.fps || 30)).toFixed(2)
    : '—'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>视频开头帧移除工具</h1>
          <span className="sub">批量移除视频开头画面</span>
        </div>
        <button className="btn primary" onClick={addFiles} disabled={processing}>
          + 添加视频
        </button>
        <div className="frames-input">
          <label>移除前</label>
          <input
            type="number"
            min={1}
            max={10000}
            value={framesToRemove}
            disabled={processing}
            onChange={(e) => setFramesToRemove(Math.max(1, Number(e.target.value) || 1))}
          />
          <label>帧</label>
          <span className="hint">≈ {secondsText} 秒{selected?.info ? `（${selected.info.fps?.toFixed(0) ?? '?'} fps）` : ''}</span>
        </div>
      </header>

      <div className="main">
        <aside className="file-list">
          {files.length === 0 && (
            <div className="empty">
              <p>还没有视频</p>
              <button className="btn" onClick={addFiles}>
                点击选择视频文件
              </button>
            </div>
          )}
          {files.map((f) => {
            const st = statusLabel(f.task)
            return (
              <div
                key={f.path}
                className={'file-card' + (selectedPath === f.path ? ' selected' : '')}
                onClick={() => setSelectedPath(f.path)}
              >
                <div className="file-name">{f.name}</div>
                <div className="file-meta">
                  {f.probeError
                    ? '无法读取视频'
                    : f.info
                      ? `${fmtDuration(f.info.duration)} · ${f.info.width}x${f.info.height} · ${fmtSize(f.info.size)}`
                      : '读取中…'}
                </div>
                {st && <span className={`status ${st.cls}`}>{st.text}</span>}
                {f.task?.status === 'error' && f.task.error && <div className="file-err">{f.task.error}</div>}
                <button
                  className="remove"
                  title="移除"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeFile(f.path)
                  }}
                >
                  ×
                </button>
              </div>
            )
          })}
        </aside>

        <section className="preview">
          {!selected ? (
            <div className="preview-empty">选择左侧视频查看开头画面预览</div>
          ) : selected.probeError ? (
            <div className="preview-error">无法读取该视频，请检查文件是否损坏或格式是否支持。</div>
          ) : (
            <>
              <div className="preview-head">
                <span className="pv-name">{selected.name}</span>
                <span className="pv-info">
                  {selected.info
                    ? `${fmtDuration(selected.info.duration)} · ${selected.info.width}x${selected.info.height} · ${
                        selected.info.videoCodec
                      } · ${selected.info.fps ? selected.info.fps.toFixed(0) + ' fps' : ''}`
                    : ''}
                </span>
              </div>
              <div className="thumbs">
                {(selected.thumbs?.urls ?? []).map((url, i) => (
                  <figure key={url} className="thumb" onClick={() => void openZoom(i)}>
                    <img src={url} alt={`第${i + 1}帧`} loading="lazy" />
                    <figcaption>第 {i + 1} 帧</figcaption>
                  </figure>
                ))}
                {!selected.thumbs && <div className="preview-empty">正在生成预览…</div>}
                {selected.thumbs && selected.thumbs.urls.length === 0 && (
                  <div className="preview-empty">未能提取画面</div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <footer className="bottombar">
        <div className="progress-wrap">
          {processing && (
            <div className="progress">
              <div className="progress-bar" style={{ width: `${overall}%` }} />
            </div>
          )}
          <span className="summary">{summary}</span>
        </div>
        <div className="actions">
          {processing ? (
            <button className="btn warn" onClick={cancelTrim}>
              取消
            </button>
          ) : (
            <button
              className="btn primary big"
              onClick={startTrim}
              disabled={!files.some((f) => f.info && !f.probeError)}
            >
              开始处理
            </button>
          )}
          {files.some((f) => f.task?.status === 'done') && (
            <button
              className="btn"
              onClick={() => {
                const done = files.find((f) => f.task?.status === 'done')
                if (done?.task?.outPath) void window.api.revealInFolder(done.task.outPath)
              }}
            >
              打开输出文件夹
            </button>
          )}
        </div>
      </footer>

      {zoom && (
        <div className="zoom-mask" onClick={() => setZoom(null)}>
          <div className="zoom-box" onClick={(e) => e.stopPropagation()}>
            {zoom.loading && <div className="zoom-loading">正在加载高清帧…</div>}
            {!zoom.loading && zoom.error && <div className="zoom-error">加载失败：{zoom.error}</div>}
            {!zoom.loading && !zoom.error && zoom.url && <img src={zoom.url} alt={`第${zoom.index + 1}帧`} />}
            <div className="zoom-info">
              第 {zoom.index + 1} 帧 · 点击空白处或按 Esc 关闭
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
