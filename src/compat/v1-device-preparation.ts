import type { DevicePreparation } from "../shared/contracts.js";
import {
  resolveDevicePreparationCommand,
  type DevicePreparationDefinition,
  type LoadedProjectConfig,
} from "../server/config.js";
import { ConsoleError } from "../server/errors.js";
import type {
  ConnectorDevice,
  ConnectorPreparationRequest,
  CommandRunner,
  DeviceConnector,
} from "../runner/sdk.js";

export function createV1DevicePreparationLifecycle(
  runner: CommandRunner,
  config?: LoadedProjectConfig,
): Pick<DeviceConnector, "prepare"> | undefined {
  if (!config?.devicePreparations?.length) return undefined;

  return {
    prepare: async (device, request) => {
      let installedDefinition: DevicePreparationDefinition | undefined;
      if (request.action === "install") {
        installedDefinition = await installPreparation(runner, config, device, request);
      }
      const preparations = await checkPreparations(runner, config, device);
      if (installedDefinition
        && preparations.find(item => item.id === installedDefinition.id)?.status !== "ready") {
        throw new ConsoleError(
          "DEVICE_PREPARATION_FAILED",
          `${installedDefinition.label}安装后检查仍未通过`,
          500,
        );
      }
      return {
        ...device,
        preparations,
      };
    },
  };
}

async function installPreparation(
  runner: CommandRunner,
  config: LoadedProjectConfig,
  device: ConnectorDevice,
  request: Extract<ConnectorPreparationRequest, { action: "install" }>,
): Promise<DevicePreparationDefinition> {
  const definition = config.devicePreparations?.find(item => item.id === request.preparationId);
  if (!definition || !definition.platforms.includes(device.platform)) {
    throw new ConsoleError("DEVICE_PREPARATION_UNKNOWN", `设备准备项不存在: ${request.preparationId}`, 404);
  }
  const command = resolveDevicePreparationCommand(config, definition, "install", device);
  if (!command) {
    throw new ConsoleError("DEVICE_PREPARATION_UNAVAILABLE", `${definition.label} 未配置安装命令`, 409);
  }
  const result = await runner.capture(command.executable, command.args, 10 * 60_000, {
    cwd: command.cwd,
    env: command.env,
  });
  if (result.code !== 0) {
    throw new ConsoleError(
      "DEVICE_PREPARATION_FAILED",
      `${definition.label}安装失败\n${result.stderr || result.stdout}`,
      500,
    );
  }
  return definition;
}

function checkPreparations(
  runner: CommandRunner,
  config: LoadedProjectConfig,
  device: ConnectorDevice,
): Promise<DevicePreparation[]> {
  const definitions = config.devicePreparations?.filter(item => item.platforms.includes(device.platform)) ?? [];
  return Promise.all(definitions.map(definition => checkPreparation(runner, config, definition, device)));
}

async function checkPreparation(
  runner: CommandRunner,
  config: LoadedProjectConfig,
  definition: DevicePreparationDefinition,
  device: ConnectorDevice,
): Promise<DevicePreparation> {
  const command = resolveDevicePreparationCommand(config, definition, "check", device)!;
  const result = await runner.capture(command.executable, command.args, 30_000, {
    cwd: command.cwd,
    env: command.env,
  });
  return {
    id: definition.id,
    label: definition.label,
    status: result.code === 0 ? "ready" : "required",
    detail: result.code === 0 ? definition.readyDetail : definition.requiredDetail,
    installable: Boolean(definition.install),
    blocksTests: definition.blocksTests,
  };
}
