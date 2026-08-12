import { hilog } from '@kit.PerformanceAnalysisKit';
import { LynxView, LynxViewClient } from '@lynx/lynx';

class ExampleLynxViewClient extends LynxViewClient {
  onFirstScreen(): void {
    hilog.info(0x0000, 'MTCExample', 'MTC_EVENT page_ready');
  }
}

@Entry
@Component
struct Index {
  private bundle?: ArrayBuffer;
  private clients: LynxViewClient[] = [new ExampleLynxViewClient()];

  aboutToAppear(): void {
    try {
      const data = getContext(this).resourceManager.getRawFileContentSync('main.bundle');
      this.bundle = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      hilog.info(0x0000, 'MTCExample', 'MTC_EVENT page_opened');
    } catch (error) {
      hilog.error(0x0000, 'MTCExample', 'MTC_EVENT page_open_failed %{public}s', JSON.stringify(error));
    }
  }

  build() {
    Stack() {
      if (this.bundle) {
        LynxView({
          url: 'example://lynx/main',
          buffer: this.bundle,
          clients: this.clients,
        })
          .width('100%')
          .height('100%')
      } else {
        Text('main.bundle 加载失败')
          .fontSize(16)
          .fontColor('#B91C1C')
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFFFFF')
  }
}
