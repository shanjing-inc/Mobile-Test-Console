import { AlertCircle, ArrowDown, ArrowUp, ExternalLink, ImageIcon, LayoutGrid, LoaderCircle, Maximize2, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { activeComparisonKeyAtOffset, adjacentComparisonKey, shouldHandleComparisonShortcut } from "./screenshot-comparison-scroll";
import { survivingScreenshotKey, type ScreenshotReaderItem } from "./screenshot-reader-items";

export function ScreenshotReader({ items, waiting = false }: { items: ScreenshotReaderItem[]; waiting?: boolean }) {
  const [selectedKey, setSelectedKey] = useState(items[0]?.key ?? "");
  const [overview, setOverview] = useState(false);
  const [focused, setFocused] = useState(false);
  const activeKey = survivingScreenshotKey(items, selectedKey);
  const activeIndex = items.findIndex(item => item.key === activeKey);
  const hasItems = items.length > 0;
  const selectionMissing = selectedKey !== activeKey;
  const streamRef = useRef<HTMLDivElement>(null);
  const directoryRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const focusButtonRef = useRef<HTMLButtonElement>(null);
  const pageRefs = useRef(new Map<string, HTMLElement>());
  const pendingScrollRef = useRef<string | null>(null);
  const focusStreamOnRestoreRef = useRef(false);
  const positionRef = useRef({ key: activeKey, fraction: 0 });
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;

  const rememberPosition = () => {
    const stream = streamRef.current;
    const page = pageRefs.current.get(activeKey);
    // A navigation target becomes selected before its smooth scroll completes.
    // Keep that target through mode changes instead of saving an in-flight offset.
    if (pendingScrollRef.current) positionRef.current = { key: pendingScrollRef.current, fraction: 0 };
    else if (stream && page) positionRef.current = { key: activeKey, fraction: (stream.scrollTop - page.offsetTop) / Math.max(1, page.offsetHeight) };
    pendingScrollRef.current = null;
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (focused && hasItems) dialog?.showModal();
    else if (focused) setFocused(false);
    else if (dialog?.open) {
      dialog.close();
      const previous = returnFocusRef.current;
      (previous?.isConnected ? previous : focusButtonRef.current)?.focus({ preventScroll: true });
    }
  }, [focused, hasItems]);

  useEffect(() => {
    if (selectionMissing) {
      positionRef.current = { key: activeKey, fraction: 0 };
      pendingScrollRef.current = null;
      setSelectedKey(activeKey);
    }
  }, [activeKey, selectionMissing]);

  // Re-mounting the shared surface for focus/overview keeps one selection and
  // restores the position within that page, even when its viewport height changes.
  useEffect(() => {
    if (overview) return;
    const stream = streamRef.current;
    if (!stream) return;
    const restore = () => {
      const key = activeKeyRef.current;
      const page = pageRefs.current.get(key);
      if (!page) return;
      const position = positionRef.current;
      stream.scrollTop = page.offsetTop + (position.key === key ? position.fraction * page.offsetHeight : 0);
    };
    restore();
    if (focusStreamOnRestoreRef.current) {
      stream.focus({ preventScroll: true });
      focusStreamOnRestoreRef.current = false;
    }
    const observer = new ResizeObserver(restore);
    observer.observe(stream);
    return () => observer.disconnect();
  }, [focused, overview, hasItems, selectionMissing]);

  useEffect(() => {
    const directory = directoryRef.current;
    const button = directory?.querySelector<HTMLButtonElement>('[aria-current="page"]');
    if (!directory || !button) return;
    // Scroll only the directory; scrollIntoView would also move the outer result pane.
    if (button.offsetTop < directory.scrollTop) directory.scrollTop = button.offsetTop;
    else if (button.offsetTop + button.offsetHeight > directory.scrollTop + directory.clientHeight) {
      directory.scrollTop = button.offsetTop + button.offsetHeight - directory.clientHeight;
    }
  }, [activeKey, focused, overview]);

  const select = (key: string) => {
    setSelectedKey(key);
    positionRef.current = { key, fraction: 0 };
    if (overview) {
      focusStreamOnRestoreRef.current = true;
      setOverview(false);
      return;
    }
    const stream = streamRef.current;
    const page = pageRefs.current.get(key);
    if (stream && page) {
      pendingScrollRef.current = key;
      stream.scrollTo({ top: page.offsetTop, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  };

  const syncFromScroll = () => {
    const stream = streamRef.current;
    if (!stream) return;
    const pending = pendingScrollRef.current && pageRefs.current.get(pendingScrollRef.current);
    if (pending && Math.abs(stream.scrollTop - Math.min(pending.offsetTop, stream.scrollHeight - stream.clientHeight)) > 2) return;
    pendingScrollRef.current = null;
    const positions = items.flatMap(item => {
      const page = pageRefs.current.get(item.key);
      return page ? [{ key: item.key, top: page.offsetTop }] : [];
    });
    const key = activeComparisonKeyAtOffset(positions, stream.scrollTop + Math.min(120, stream.clientHeight * 0.25));
    if (key) {
      setSelectedKey(key);
      const page = pageRefs.current.get(key)!;
      positionRef.current = { key, fraction: (stream.scrollTop - page.offsetTop) / Math.max(1, page.offsetHeight) };
    }
  };

  const interruptPendingScroll = () => {
    if (!pendingScrollRef.current) return;
    pendingScrollRef.current = null;
    // At a scroll boundary, interruption may produce no subsequent scroll event.
    syncFromScroll();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    // Native scrolling can interrupt smooth navigation. Release its selection
    // guard while leaving the browser's key behavior (including editing) intact.
    if (["PageUp", "PageDown", "Home", "End", " "].includes(event.key)) interruptPendingScroll();
    if (!shouldHandleComparisonShortcut(event, target)) return;
    event.preventDefault();
    event.stopPropagation();
    select(adjacentComparisonKey(items.map(item => item.key), activeKey, event.key === "ArrowDown" ? 1 : -1));
  };

  const exitFocus = () => {
    rememberPosition();
    setFocused(false);
  };

  if (items.length === 0) return <div className="result-empty">
    {waiting ? <LoaderCircle className="spin" size={18} /> : <ImageIcon size={18} />}
    <strong>{waiting ? "等待首张截图" : "没有截图"}</strong>
    <span>{waiting ? "Runner 发布截图后会在这里实时展示" : "当前运行未生成 PNG、JPEG 或 WebP 图片"}</span>
  </div>;

  const content = <div className={`screenshot-reader-surface ${focused ? "is-focused" : ""}`} onKeyDown={onKeyDown}>
    <div className="screenshot-reader-toolbar">
      <div className="screenshot-reader-navigation">
        <button type="button" aria-label="上一张" title="上一张（↑）" disabled={activeIndex <= 0} onClick={() => select(adjacentComparisonKey(items.map(item => item.key), activeKey, -1))}><ArrowUp size={16} /></button>
        <span className="screenshot-reader-count" aria-label="当前截图" aria-live="polite">{activeIndex + 1} / {items.length}</span>
        <button type="button" aria-label="下一张" title="下一张（↓）" disabled={activeIndex === items.length - 1} onClick={() => select(adjacentComparisonKey(items.map(item => item.key), activeKey, 1))}><ArrowDown size={16} /></button>
      </div>
      <div className="screenshot-reader-actions">
        <button type="button" aria-pressed={overview} onClick={() => { rememberPosition(); setOverview(value => !value); }}><LayoutGrid size={14} />{overview ? "返回阅读" : "缩略图总览"}</button>
        <button ref={focusButtonRef} type="button" onClick={focused ? exitFocus : () => {
          rememberPosition();
          returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setFocused(true);
        }}>{focused ? <X size={14} /> : <Maximize2 size={14} />}{focused ? "退出专注" : "专注阅读"}</button>
      </div>
    </div>
    {overview ? <div className="screenshot-reader-overview" aria-label="截图总览">
      {items.map((item, index) => <button type="button" className="screenshot-reader-thumbnail" key={item.key} aria-label={`阅读第 ${index + 1} 张：${item.title}`} aria-current={item.key === activeKey ? "page" : undefined} onClick={() => select(item.key)}>
        <div className="screenshot-reader-thumbnail-image"><ReaderImage key={item.url} item={item} /></div>
        <strong>{index + 1}. {item.title}</strong><small title={item.label}>{item.label}</small>
      </button>)}
    </div> : <div className="screenshot-reader-layout">
      <nav className="screenshot-reader-directory" aria-label="截图页面" ref={directoryRef}>
        {items.map((item, index) => <button key={item.key} type="button" aria-current={item.key === activeKey ? "page" : undefined} onClick={() => select(item.key)} title={item.label}>
          <span>{index + 1}</span><div><strong>{item.title}</strong>{item.subtitle && <small>{item.subtitle}</small>}</div>
        </button>)}
      </nav>
      <div className="screenshot-reader-stream" tabIndex={0} role="region" aria-label="截图阅读区，使用上下方向键切换" ref={streamRef} onScroll={syncFromScroll} onWheel={interruptPendingScroll} onTouchStart={interruptPendingScroll} onPointerDown={interruptPendingScroll}>
        {items.map((item, index) => <section className="screenshot-reader-page" key={item.key} data-screenshot-key={item.key} aria-label={`第 ${index + 1} 张：${item.title}`} ref={element => { if (element) pageRefs.current.set(item.key, element); else pageRefs.current.delete(item.key); }}>
          <div className="screenshot-reader-caption"><div><strong>{item.title}</strong><small title={item.label}>{item.subtitle ? `${item.subtitle} · ` : ""}{item.label}</small></div><a href={item.url} target="_blank" rel="noreferrer" aria-label={`查看原图：${item.label}`}><ExternalLink size={13} />原图</a></div>
          <div className="screenshot-reader-image"><ReaderImage key={item.url} item={item} /></div>
        </section>)}
      </div>
    </div>}
  </div>;

  return <div className="screenshot-reader">
    {!focused && content}
    <dialog className="screenshot-reader-dialog" ref={dialogRef} aria-label="截图专注阅读" onCancel={event => { event.preventDefault(); exitFocus(); }} onClose={() => { if (focused) setFocused(false); }}>
      {focused && content}
    </dialog>
  </div>;
}

function ReaderImage({ item }: { item: ScreenshotReaderItem }) {
  const [status, setStatus] = useState<"loading" | "loaded" | "failed">("loading");
  return <>
    {status === "loading" && <span className="screenshot-reader-image-status"><LoaderCircle className="spin" size={18} />正在加载截图</span>}
    {status === "failed" ? <span className="screenshot-reader-image-status" role="status"><AlertCircle size={20} /><strong>截图无法读取</strong><small>{item.label}</small></span>
      : <img src={item.url} alt={item.alt || item.label} loading="lazy" onLoad={() => setStatus("loaded")} onError={() => setStatus("failed")} />}
  </>;
}
