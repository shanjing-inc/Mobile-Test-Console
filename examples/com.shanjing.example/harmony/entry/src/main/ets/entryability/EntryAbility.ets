import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { LynxEnv } from '@lynx/lynx';

export default class EntryAbility extends UIAbility {
  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    LynxEnv.initialize(this.context);
    hilog.info(0x0000, 'MTCExample', 'MTC_EVENT app_created');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (error) => {
      if (error.code) {
        hilog.error(0x0000, 'MTCExample', 'MTC_EVENT page_open_failed %{public}s', JSON.stringify(error));
      }
    });
  }
}
