import { PubsubMain } from '@teambit/pubsub';
import type { AspectLoaderMain } from '@teambit/aspect-loader';
import { BundlerMain } from '@teambit/bundler';
import { CLIMain, CommandList } from '@teambit/cli';
import { DependencyResolverAspect, DependencyResolverMain } from '@teambit/dependency-resolver';
import type { ComponentMain, Component } from '@teambit/component';
import { EnvsMain } from '@teambit/envs';
import { GraphqlMain } from '@teambit/graphql';
import { Harmony, SlotRegistry } from '@teambit/harmony';
import { IsolatorMain } from '@teambit/isolator';
import { LoggerMain } from '@teambit/logger';
import type { ScopeMain } from '@teambit/scope';
import { UiMain } from '@teambit/ui';
import type { VariantsMain } from '@teambit/variants';
import { Consumer, loadConsumerIfExist } from '@teambit/legacy/dist/consumer';
import ConsumerComponent from '@teambit/legacy/dist/consumer/component';
import type { ComponentConfigLoadOptions } from '@teambit/legacy/dist/consumer/config';
import { ExtensionDataList } from '@teambit/legacy/dist/consumer/config/extension-data';
import LegacyComponentLoader, { ComponentLoadOptions } from '@teambit/legacy/dist/consumer/component/component-loader';
import { ComponentID } from '@teambit/component-id';
import { GlobalConfigMain } from '@teambit/global-config';
import { EXT_NAME } from './constants';
import EjectConfCmd from './eject-conf.cmd';
import { OnComponentLoad, OnComponentAdd, OnComponentChange, OnComponentRemove } from './on-component-events';
import { WorkspaceExtConfig } from './types';
import { Workspace } from './workspace';
import getWorkspaceSchema from './workspace.graphql';
import { WorkspaceUIRoot } from './workspace.ui-root';
import { CapsuleCmd, CapsuleCreateCmd, CapsuleDeleteCmd, CapsuleListCmd } from './capsule.cmd';
import { EnvsSetCmd } from './envs-subcommands/envs-set.cmd';
import { EnvsUnsetCmd } from './envs-subcommands/envs-unset.cmd';
import { PatternCommand } from './pattern.cmd';
import { EnvsReplaceCmd } from './envs-subcommands/envs-replace.cmd';
import { ScopeSetCmd } from './scope-subcommands/scope-set.cmd';
import { UseCmd } from './use.cmd';
import { EnvsUpdateCmd } from './envs-subcommands/envs-update.cmd';

export type WorkspaceDeps = [
  PubsubMain,
  CLIMain,
  ScopeMain,
  ComponentMain,
  IsolatorMain,
  DependencyResolverMain,
  VariantsMain,
  LoggerMain,
  GraphqlMain,
  UiMain,
  BundlerMain,
  AspectLoaderMain,
  EnvsMain,
  GlobalConfigMain
];

export type OnComponentLoadSlot = SlotRegistry<OnComponentLoad>;

export type OnComponentChangeSlot = SlotRegistry<OnComponentChange>;

export type OnComponentAddSlot = SlotRegistry<OnComponentAdd>;

export type OnComponentRemoveSlot = SlotRegistry<OnComponentRemove>;

export type OnBitmapChange = () => Promise<void>;
export type OnBitmapChangeSlot = SlotRegistry<OnBitmapChange>;

export type OnAspectsResolve = (aspectsComponents: Component[]) => Promise<void>;
export type OnAspectsResolveSlot = SlotRegistry<OnAspectsResolve>;

export type OnRootAspectAdded = (aspectsId: ComponentID, inWs: boolean) => Promise<void>;
export type OnRootAspectAddedSlot = SlotRegistry<OnRootAspectAdded>;

export default async function provideWorkspace(
  [
    pubsub,
    cli,
    scope,
    component,
    isolator,
    dependencyResolver,
    variants,
    loggerExt,
    graphql,
    ui,
    bundler,
    aspectLoader,
    envs,
    globalConfig,
  ]: WorkspaceDeps,
  config: WorkspaceExtConfig,
  [
    onComponentLoadSlot,
    onComponentChangeSlot,
    onComponentAddSlot,
    onComponentRemoveSlot,
    onAspectsResolveSlot,
    onRootAspectAddedSlot,
    onBitmapChangeSlot,
  ]: [
    OnComponentLoadSlot,
    OnComponentChangeSlot,
    OnComponentAddSlot,
    OnComponentRemoveSlot,
    OnAspectsResolveSlot,
    OnRootAspectAddedSlot,
    OnBitmapChangeSlot
  ],
  harmony: Harmony
) {
  const bitConfig: any = harmony.config.get('teambit.harmony/bit');
  const consumer = await getConsumer(bitConfig.cwd);
  if (!consumer) {
    const capsuleCmd = getCapsulesCommands(isolator, scope, undefined);
    cli.register(capsuleCmd);
    return undefined;
  }
  // TODO: get the 'workspace' name in a better way
  const logger = loggerExt.createLogger(EXT_NAME);
  const workspace = new Workspace(
    pubsub,
    config,
    consumer,
    scope,
    component,
    dependencyResolver,
    variants,
    aspectLoader,
    logger,
    undefined,
    harmony,
    onComponentLoadSlot,
    onComponentChangeSlot,
    envs,
    globalConfig,
    onComponentAddSlot,
    onComponentRemoveSlot,
    onAspectsResolveSlot,
    onRootAspectAddedSlot,
    graphql,
    onBitmapChangeSlot
  );

  const configMergeFile = workspace.getConflictMergeFile();
  await configMergeFile.loadIfNeeded();

  const getWorkspacePolicyFromPackageJson = () => {
    const packageJson = workspace.consumer.packageJson?.packageJsonObject || {};
    const policyFromPackageJson = dependencyResolver.getWorkspacePolicyFromPackageJson(packageJson);
    return policyFromPackageJson;
  };

  const getWorkspacePolicyFromMergeConfig = () => {
    const wsConfigMerge = workspace.getWorkspaceJsonConflictFromMergeConfig();
    const policy = wsConfigMerge.data?.[DependencyResolverAspect.id]?.policy || {};
    ['dependencies', 'peerDependencies'].forEach((depField) => {
      if (!policy[depField]) return;
      policy[depField] = policy[depField].reduce((acc, current) => {
        acc[current.name] = current.version;
        return acc;
      }, {});
    });
    const wsPolicy = dependencyResolver.getWorkspacePolicyFromConfigObject(policy);
    return wsPolicy;
  };

  const getRootPolicy = () => {
    const pkgJsonPolicy = getWorkspacePolicyFromPackageJson();
    const configMergePolicy = getWorkspacePolicyFromMergeConfig();
    return dependencyResolver.mergeWorkspacePolices([pkgJsonPolicy, configMergePolicy]);
  };

  dependencyResolver.registerRootPolicy(getRootPolicy());

  consumer.onCacheClear.push(() => workspace.clearCache());

  LegacyComponentLoader.registerOnComponentLoadSubscriber(
    async (legacyComponent: ConsumerComponent, opts?: ComponentLoadOptions) => {
      if (opts?.originatedFromHarmony) return legacyComponent;
      const id = await workspace.resolveComponentId(legacyComponent.id);
      const newComponent = await workspace.get(id, legacyComponent, true, true, opts);
      return newComponent.state._consumer;
    }
  );

  ConsumerComponent.registerOnComponentConfigLoading(EXT_NAME, async (id, loadOpts: ComponentConfigLoadOptions) => {
    const componentId = await workspace.resolveComponentId(id);
    // We call here directly workspace.scope.get instead of workspace.get because part of the workspace get is loading consumer component
    // which in turn run this event, which will make an infinite loop
    // This component from scope here are only used for merging the extensions with the workspace components
    const componentFromScope = await workspace.scope.get(componentId);
    const { extensions } = await workspace.componentExtensions(componentId, componentFromScope, undefined, loadOpts);
    const defaultScope = await workspace.componentDefaultScope(componentId);

    const extensionsWithLegacyIdsP = extensions.map(async (extension) => {
      const legacyEntry = extension.clone();
      if (legacyEntry.extensionId) {
        legacyEntry.newExtensionId = legacyEntry.extensionId;
      }

      return legacyEntry;
    });
    const extensionsWithLegacyIds = await Promise.all(extensionsWithLegacyIdsP);

    return {
      defaultScope,
      extensions: ExtensionDataList.fromArray(extensionsWithLegacyIds),
    };
  });

  const workspaceSchema = getWorkspaceSchema(workspace, graphql);
  ui.registerUiRoot(new WorkspaceUIRoot(workspace, bundler));
  ui.registerPreStart(async () => {
    return workspace.setComponentPathsRegExps();
  });
  graphql.register(workspaceSchema);
  const capsuleCmd = getCapsulesCommands(isolator, scope, workspace);
  const commands: CommandList = [new EjectConfCmd(workspace), capsuleCmd, new UseCmd(workspace)];

  commands.push(new PatternCommand(workspace));
  cli.register(...commands);
  component.registerHost(workspace);

  cli.registerOnStart(async (_hasWorkspace: boolean, currentCommand: string) => {
    if (currentCommand === 'mini-status' || currentCommand === 'ms') {
      return; // mini-status should be super fast.
    }
    if (currentCommand === 'install') {
      workspace.inInstallContext = true;
    }
    await workspace.importCurrentLaneIfMissing();
    const loadAspectsOpts = {
      runSubscribers: false,
      skipDeps: !config.autoLoadAspectsDeps,
    };
    const aspects = await workspace.loadAspects(
      aspectLoader.getNotLoadedConfiguredExtensions(),
      undefined,
      'teambit.workspace/workspace (cli.registerOnStart)',
      loadAspectsOpts
    );
    // clear aspect cache.
    const componentIds = await workspace.resolveMultipleComponentIds(aspects);
    componentIds.forEach((id) => {
      workspace.clearComponentCache(id);
    });
  });

  // add sub-commands "set" and "unset" to envs command.
  const envsCommand = cli.getCommand('envs');
  envsCommand?.commands?.push(new EnvsSetCmd(workspace)); // bit envs set
  envsCommand?.commands?.push(new EnvsUnsetCmd(workspace)); // bit envs unset
  envsCommand?.commands?.push(new EnvsReplaceCmd(workspace)); // bit envs replace
  envsCommand?.commands?.push(new EnvsUpdateCmd(workspace)); // bit envs replace

  // add sub-command "set" to scope command.
  const scopeCommand = cli.getCommand('scope');
  scopeCommand?.commands?.push(new ScopeSetCmd(workspace));

  return workspace;
}

function getCapsulesCommands(isolator: IsolatorMain, scope: ScopeMain, workspace?: Workspace) {
  const capsuleCmd = new CapsuleCmd(isolator, workspace, scope);
  capsuleCmd.commands = [
    new CapsuleListCmd(isolator, workspace, scope),
    new CapsuleCreateCmd(workspace, scope, isolator),
    new CapsuleDeleteCmd(isolator, scope, workspace),
  ];
  return capsuleCmd;
}

/**
 * don't use loadConsumer() here, which throws ConsumerNotFound because some commands don't require
 * the consumer to be available. such as, `bit init` or `bit list --remote`.
 * most of the commands do need the consumer. the legacy commands that need the consumer throw an
 * error when is missing. in the new/Harmony commands, such as `bis compile`, the workspace object
 * is passed to the provider, so before using it, make sure it exists.
 * keep in mind that you can't verify it in the provider itself, because the provider is running
 * always for all commands before anything else is happening.
 */
async function getConsumer(path?: string): Promise<Consumer | undefined> {
  return loadConsumerIfExist(path);
}
