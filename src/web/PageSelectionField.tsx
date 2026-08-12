import { CheckSquare2, LoaderCircle, Search, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  PageParameterPage,
  PageSelectionParameterDefinition,
  Platform,
} from "../shared/contracts";
import { ApiError, fetchPageParameters } from "./api";

export function PageSelectionField({
  parameter,
  value,
  platforms,
  onChange,
  onMessage,
}: {
  parameter: PageSelectionParameterDefinition;
  value: string;
  platforms: Platform[];
  onChange: (value: string) => void;
  onMessage: (message: { kind: "error" | "info"; text: string }) => void;
}) {
  const [pages, setPages] = useState<PageParameterPage[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchPageParameters()
      .then(response => {
        if (!cancelled) setPages(response.pages);
      })
      .catch(error => {
        if (!cancelled) {
          onMessage({
            kind: "error",
            text: error instanceof ApiError ? error.message : "无法读取项目页面测试目录",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [onMessage, parameter.id]);

  const supportedPages = useMemo(() => pages.filter(page => (
    platforms.length === 0
    || !page.platforms?.length
    || platforms.every(platform => page.platforms?.includes(platform))
  )), [pages, platforms]);
  const selectedIds = useMemo(
    () => resolveSelectedPageIds(parameter, value, supportedPages),
    [parameter, supportedPages, value],
  );
  const visiblePages = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return supportedPages.filter(page => !normalized || [page.pageId, page.label, page.bundle]
      .some(item => item.toLowerCase().includes(normalized)));
  }, [query, supportedPages]);
  const visibleIds = visiblePages.map(page => page.pageId);
  const visibleSelected = visibleIds.filter(pageId => selectedIds.has(pageId)).length;

  const setExplicitSelection = (next: Set<string>) => {
    const ordered = supportedPages.map(page => page.pageId).filter(pageId => next.has(pageId));
    onChange(ordered.join(","));
  };

  return <div className="page-selection-field">
    <div className="page-selection-heading">
      <div><strong>{parameter.label}</strong><small>从项目配置和页面目录生成测试范围</small></div>
      <span>已选 {selectedIds.size} / {supportedPages.length}</span>
    </div>
    <div className="page-selection-presets" aria-label="页面测试预设">
      {parameter.presets.map(preset => {
        const matchedCount = supportedPages.filter(page => matchesPagePreset(page, preset.filter)).length;
        return <button
          key={preset.value}
          type="button"
          className={value === preset.value ? "active" : ""}
          title={matchedCount > 0 ? preset.description : `${preset.description || preset.label}：当前目录没有匹配页面`}
          onClick={() => onChange(preset.value)}
          disabled={!loading && matchedCount === 0}
        >{preset.label} <span>{matchedCount}</span></button>;
      })}
    </div>
    <div className="page-selection-toolbar">
      <label><Search size={14} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索页面、Bundle" /></label>
      <button
        type="button"
        onClick={() => {
          const next = new Set(selectedIds);
          if (visibleSelected === visibleIds.length) visibleIds.forEach(pageId => next.delete(pageId));
          else visibleIds.forEach(pageId => next.add(pageId));
          setExplicitSelection(next);
        }}
        disabled={visibleIds.length === 0}
      >{visibleSelected === visibleIds.length && visibleIds.length > 0 ? <CheckSquare2 size={14} /> : <Square size={14} />}{visibleSelected === visibleIds.length && visibleIds.length > 0 ? "取消当前" : "选择当前"}</button>
    </div>
    <div className="page-selection-list">
      {loading ? <div className="page-selection-empty"><LoaderCircle className="spin" size={16} />读取页面目录</div> : null}
      {!loading && visiblePages.length === 0 ? <div className="page-selection-empty">当前筛选没有可测试页面</div> : null}
      {visiblePages.map(page => {
        const checked = selectedIds.has(page.pageId);
        return <label className={checked ? "page-selection-row selected" : "page-selection-row"} key={page.pageId}>
          <input
            type="checkbox"
            checked={checked}
            onChange={() => {
              const next = new Set(selectedIds);
              if (checked) next.delete(page.pageId);
              else next.add(page.pageId);
              setExplicitSelection(next);
            }}
          />
          <span><strong>{page.label}</strong><small>{page.pageId} · {page.bundle || "未声明 Bundle"}</small></span>
          <span className="page-selection-meta">{page.priority || "未分级"}</span>
        </label>;
      })}
    </div>
  </div>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function resolveSelectedPageIds(
  parameter: PageSelectionParameterDefinition,
  value: string,
  pages: PageParameterPage[],
): Set<string> {
  const preset = parameter.presets.find(item => item.value === value);
  if (preset) return new Set(pages.filter(page => matchesPagePreset(page, preset.filter)).map(page => page.pageId));
  const available = new Set(pages.map(page => page.pageId));
  return new Set(value.split(",").map(item => item.trim()).filter(pageId => available.has(pageId)));
}

// eslint-disable-next-line react-refresh/only-export-components
export function matchesPagePreset(
  page: PageParameterPage,
  filter: PageSelectionParameterDefinition["presets"][number]["filter"],
): boolean {
  if (filter.priorities?.length && !filter.priorities.includes(page.priority ?? "")) return false;
  if (filter.tags?.length && !filter.tags.some(tag => page.tags?.includes(tag))) return false;
  if (filter.testScopes?.length && !filter.testScopes.includes(page.testScope ?? "")) return false;
  return true;
}
