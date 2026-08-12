import type { Platform } from "../shared/contracts.js";
import {
  createAppDeviceConnectorRegistry,
  type IosSimulatorProjectConfig,
} from "../runner/app-device-connectors.js";
import type { CommandRunner } from "../runner/sdk.js";
import { createV1DevicePreparationLifecycle } from "./v1-device-preparation.js";
import type { LoadedProjectConfig } from "../server/config.js";
import type { InProcessConnectorRegistry } from "../runner/sdk.js";

export function createV1AppDeviceConnectorRegistry(
  runner: CommandRunner,
  platforms: readonly Platform[],
  iosSimulator: IosSimulatorProjectConfig | undefined,
  config?: LoadedProjectConfig,
): InProcessConnectorRegistry {
  const preparationLifecycle = createV1DevicePreparationLifecycle(runner, config);
  const preparePlatforms = config?.devicePreparations
    ?.flatMap(preparation => preparation.platforms)
    .filter((platform, index, platforms) => platforms.indexOf(platform) === index);
  return createAppDeviceConnectorRegistry(runner, platforms, {
    iosSimulator,
    prepare: preparationLifecycle?.prepare,
    preparePlatforms,
  });
}
