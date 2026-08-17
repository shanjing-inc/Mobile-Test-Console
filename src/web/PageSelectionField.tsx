import { CheckCheck, ListChecks, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  PageParameterPage,
  PageSelectionParameterDefinition,
  Platform,
} from "../shared/contracts";
import { ApiError, fetchPageParameters } from "./api";

export interface PageSelectionItem {
  id: string;
  label: string;
  secondary?: string;
  searchText?: string;
  badge?: string;
  platforms?: string[];
  metadata?: {
    priority?: string;
    tags?: string[];
    scope?: string;
  };
}

export function PageSelectionField({
  parameter,
  value,
  platforms,
  onChange,
  onMessage,
  items,
}: {
  parameter: PageSelectionParameterDefinition;
  value: string;
  platforms: Platform[];
  onChange: (value: string) => void;
  onMessage: (message: { kind: "error" | "info"; text: string }) => void;
  items?: PageSelectionItem[];
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
  const selectionItems = useMemo<PageSelectionItem[]>(() => items ?? supportedPages.map(page => ({
    id: page.pageId,
    label: page.label,
    secondary: `${page.pageId} · ${page.bundle || "未声明 Bundle"}`,
    searchText: `${page.pageId} ${page.label} ${page.bundle}`,
    badge: page.priority || "未分级",
    platforms: page.platforms,
    metadata: { priority: page.priority, tags: page.tags, scope: page.testScope },
  })), [items, supportedPages]);
  const selectedIds = useMemo(
    () => resolveSelectedIds(parameter, value, selectionItems),
    [parameter, selectionItems, value],
  );
  const visiblePages = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return selectionItems.filter(item => !normalized || `${item.id} ${item.label} ${item.secondary || ""} ${item.searchText || ""}`.toLowerCase().includes(normalized));
  }, [query, selectionItems]);
  const visibleIds = visiblePages.map(item => item.id);
  const visibleSelected = visibleIds.filter(pageId => selectedIds.has(pageId)).length;

  const setExplicitSelection = (next: Set<string>) => {
    const ordered = selectionItems.map(item => item.id).filter(id => next.has(id));
    onChange(ordered.join(","));
  };

  const toggleVisible = () => {
    const next = new Set(selectedIds);
    if (visibleSelected === visibleIds.length) visibleIds.forEach(pageId => next.delete(pageId));
    else visibleIds.forEach(pageId => next.add(pageId));
    setExplicitSelection(next);
  };

  const clearSelection = () => setExplicitSelection(new Set());

  return <div className="page-selection-field">
    <div className="page-selection-heading">
      <div><strong>{parameter.label}</strong><small>从项目配置和页面目录生成测试范围</small></div>
      <span>已选 {selectedIds.size} / {selectionItems.length}</span>
    </div>
    <div className="page-selection-presets" aria-label="页面测试预设">
      {parameter.presets.map(preset => {
        const matchedCount = selectionItems.filter(item => matchesSelectionPreset(item, preset.filter)).length;
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
      <div className="page-selection-actions">
        <button type="button" onClick={toggleVisible} disabled={visibleIds.length === 0} title="切换当前筛选结果的选择状态"><CheckCheck size={14} />{visibleSelected === visibleIds.length ? "取消当前" : "全选当前"}</button>
        <button type="button" onClick={clearSelection} disabled={selectedIds.size === 0} title="清空所有页面选择"><X size={14} />清空</button>
      </div>
    </div>
    <div className="page-selection-summary">
      <span><ListChecks size={14} />当前筛选 {visibleIds.length} 项，已选 {visibleSelected} 项</span>
    </div>
    <div className="page-selection-list">
      {loading ? <div className="page-selection-empty"><LoaderCircle className="spin" size={16} />读取页面目录</div> : null}
      {!loading && visiblePages.length === 0 ? <div className="page-selection-empty">当前筛选没有可测试页面</div> : null}
      {visiblePages.map(page => {
        const checked = selectedIds.has(page.id);
        return <label className={checked ? "page-selection-row selected" : "page-selection-row"} key={page.id}>
          <input
            type="checkbox"
            checked={checked}
            onChange={() => {
              const next = new Set(selectedIds);
              if (checked) next.delete(page.id);
              else next.add(page.id);
              setExplicitSelection(next);
            }}
          />
          <span><strong>{page.label}</strong><small>{page.secondary || page.id}</small></span>
          <span className="page-selection-meta">{page.badge || ""}</span>
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
  return resolveSelectedIds(parameter, value, pages.map(page => ({ id: page.pageId, label: page.label, metadata: { priority: page.priority, tags: page.tags, scope: page.testScope } })));
}

// eslint-disable-next-line react-refresh/only-export-components
export function resolveSelectedIds(parameter: PageSelectionParameterDefinition, value: string, items: PageSelectionItem[]): Set<string> {
  const preset = parameter.presets.find(item => item.value === value);
  if (preset) return new Set(items.filter(item => matchesSelectionPreset(item, preset.filter)).map(item => item.id));
  const available = new Set(items.map(item => item.id));
  return new Set(value.split(",").map(item => item.trim()).filter(id => available.has(id)));
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

// eslint-disable-next-line react-refresh/only-export-components
export function matchesSelectionPreset(item: PageSelectionItem, filter: PageSelectionParameterDefinition["presets"][number]["filter"]): boolean {
  if (filter.priorities?.length && !filter.priorities.includes(item.metadata?.priority ?? "")) return false;
  if (filter.tags?.length && !filter.tags.some(tag => item.metadata?.tags?.includes(tag))) return false;
  if (filter.testScopes?.length && !filter.testScopes.includes(item.metadata?.scope ?? "")) return false;
  return true;
}
