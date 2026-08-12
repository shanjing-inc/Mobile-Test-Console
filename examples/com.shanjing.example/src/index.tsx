import { root } from "@lynx-js/react";
import "./index.css";

export function ExamplePage() {
  return (
    <view className="page">
      <view className="status-mark">
        <text className="status-mark-text">MTC</text>
      </view>
      <text className="title">Lynx 测试示例</text>
      <text className="description">com.shanjing.example 已成功加载单页 Bundle</text>
      <view className="status-row">
        <view className="status-dot" />
        <text className="status-text">page_ready</text>
      </view>
    </view>
  );
}

root.render(<ExamplePage />);

if ((import.meta as unknown as { webpackHot?: { accept(): void } }).webpackHot) {
  (import.meta as unknown as { webpackHot: { accept(): void } }).webpackHot.accept();
}
