import chalk from 'chalk';
import R from 'ramda';
import { BitError } from '@teambit/bit-error';
import { LaneId } from '@teambit/lane-id';
import pMapSeries from 'p-map-series';
import { getRemoteBitIdsByWildcards } from '@teambit/legacy/dist/api/consumer/lib/list-scope';
import { ComponentID, ComponentIdList } from '@teambit/component-id';
import { Consumer } from '@teambit/legacy/dist/consumer';
import loader from '@teambit/legacy/dist/cli/loader';
import { BEFORE_IMPORT_ACTION } from '@teambit/legacy/dist/cli/loader/loader-messages';
import GeneralError from '@teambit/legacy/dist/error/general-error';
import logger from '@teambit/legacy/dist/logger/logger';
import { Scope } from '@teambit/legacy/dist/scope';
import { Lane, ModelComponent, Version } from '@teambit/legacy/dist/scope/models';
import { getLatestVersionNumber, pathNormalizeToLinux } from '@teambit/legacy/dist/utils';
import hasWildcard from '@teambit/legacy/dist/utils/string/has-wildcard';
import Component from '@teambit/legacy/dist/consumer/component';
import { applyModifiedVersion } from '@teambit/checkout';
import {
  FileStatus,
  getMergeStrategyInteractive,
  MergeOptions,
  threeWayMerge,
} from '@teambit/legacy/dist/consumer/versions-ops/merge-version';
import { FilesStatus, MergeStrategy } from '@teambit/legacy/dist/consumer/versions-ops/merge-version/merge-version';
import { MergeResultsThreeWay } from '@teambit/legacy/dist/consumer/versions-ops/merge-version/three-way-merge';
import ComponentsPendingMerge from '@teambit/legacy/dist/consumer/component-ops/exceptions/components-pending-merge';
import ScopeComponentsImporter from '@teambit/legacy/dist/scope/component-ops/scope-components-importer';
import VersionDependencies, {
  multipleVersionDependenciesToConsumer,
} from '@teambit/legacy/dist/scope/version-dependencies';
import { GraphMain } from '@teambit/graph';
import { Workspace } from '@teambit/workspace';
import { ComponentWriterMain, ComponentWriterResults, ManyComponentsWriterParams } from '@teambit/component-writer';
import { LATEST_VERSION } from '@teambit/component-version';
import { EnvsMain } from '@teambit/envs';
import { compact } from 'lodash';

export type ImportOptions = {
  ids: string[]; // array might be empty
  verbose?: boolean;
  merge?: boolean;
  mergeStrategy?: MergeStrategy;
  filterEnvs?: string[];
  writeToPath?: string;
  writeConfig?: boolean;
  override?: boolean;
  installNpmPackages: boolean; // default: true
  writeConfigFiles: boolean; // default: true
  objectsOnly?: boolean;
  saveDependenciesAsComponents?: boolean;
  importDependenciesDirectly?: boolean; // default: false, normally it imports them as packages, not as imported
  importDependents?: boolean;
  fromOriginalScope?: boolean; // default: false, otherwise, it fetches flattened dependencies from their dependents
  saveInLane?: boolean; // save the imported component on the current lane (won't be available on main)
  lanes?: {
    laneIds: LaneId[];
    lanes: Lane[]; // it can be an empty array when a lane is a local lane and doesn't exist on the remote
  };
  allHistory?: boolean;
  fetchDeps?: boolean; // by default, if a component was tagged with > 0.0.900, it has the flattened-deps-graph in the object
  trackOnly?: boolean;
  includeDeprecated?: boolean;
  isLaneFromRemote?: boolean; // whether the `lanes.lane` object is coming directly from the remote.
};
type ComponentMergeStatus = {
  component: Component;
  mergeResults: MergeResultsThreeWay | null | undefined;
};
type ImportedVersions = { [id: string]: string[] };
export type ImportStatus = 'added' | 'updated' | 'up to date';
export type ImportDetails = {
  id: string;
  versions: string[];
  latestVersion: string | null;
  status: ImportStatus;
  filesStatus: FilesStatus | null | undefined;
  missingDeps: ComponentID[];
  deprecated: boolean;
  removed?: boolean;
};
export type ImportResult = {
  importedIds: ComponentID[];
  importedDeps: ComponentID[];
  writtenComponents?: Component[];
  importDetails: ImportDetails[];
  cancellationMessage?: string;
  installationError?: Error;
  compilationError?: Error;
  missingIds?: string[]; // in case the import is configured to not throw when missing
};

export default class ImportComponents {
  consumer: Consumer;
  scope: Scope;
  mergeStatus: { [id: string]: FilesStatus };
  private laneObjects: Lane[];
  private divergeData: Array<ModelComponent> = [];
  constructor(
    private workspace: Workspace,
    private graph: GraphMain,
    private componentWriter: ComponentWriterMain,
    private envs: EnvsMain,
    public options: ImportOptions
  ) {
    this.consumer = this.workspace.consumer;
    this.scope = this.consumer.scope;
    this.laneObjects = this.options.lanes ? (this.options.lanes.lanes as Lane[]) : [];
  }

  async importComponents(): Promise<ImportResult> {
    let result;
    loader.start(BEFORE_IMPORT_ACTION);
    const startTime = process.hrtime();
    this.options.saveDependenciesAsComponents = this.consumer.config._saveDependenciesAsComponents;
    if (this.options.lanes && !this.options.ids.length) {
      result = await this.importObjectsOnLane();
      loader.succeed(BEFORE_IMPORT_ACTION, startTime);
      return result;
    }
    if (this.options.ids.length) {
      result = await this.importSpecificComponents();
      loader.succeed(BEFORE_IMPORT_ACTION, startTime);
      return result;
    }
    result = await this.importAccordingToBitMap();
    loader.succeed(BEFORE_IMPORT_ACTION, startTime);
    return result;
  }

  async importObjectsOnLane(): Promise<ImportResult> {
    if (!this.options.objectsOnly) {
      throw new Error(`importObjectsOnLane should have objectsOnly=true`);
    }
    if (this.laneObjects.length > 1) {
      throw new Error(`importObjectsOnLane does not support more than one lane`);
    }
    const lane = this.laneObjects.length ? this.laneObjects[0] : undefined;
    const bitIds: ComponentIdList = await this.getBitIds();
    lane
      ? logger.debug(`importObjectsOnLane, Lane: ${lane.id()}, Ids: ${bitIds.toString()}`)
      : logger.debug(`importObjectsOnLane, the lane does not exist on the remote. importing only the main components`);
    const beforeImportVersions = await this._getCurrentVersions(bitIds);
    const versionDependenciesArr = await this._importComponentsObjects(bitIds, {
      lane,
    });

    // merge the lane objects
    const mergeAllLanesResults = await pMapSeries(this.laneObjects, (laneObject) =>
      this.scope.sources.mergeLane(laneObject, true)
    );
    const mergedLanes = mergeAllLanesResults.map((result) => result.mergeLane);
    await Promise.all(mergedLanes.map((mergedLane) => this.scope.lanes.saveLane(mergedLane)));

    return this.returnCompleteResults(beforeImportVersions, versionDependenciesArr);
  }

  private async returnCompleteResults(
    beforeImportVersions: ImportedVersions,
    versionDependenciesArr: VersionDependencies[],
    writtenComponents?: Component[],
    componentWriterResults?: ComponentWriterResults
  ): Promise<ImportResult> {
    const importDetails = await this._getImportDetails(beforeImportVersions, versionDependenciesArr);
    const missingIds: string[] = [];
    if (Object.keys(beforeImportVersions).length > versionDependenciesArr.length) {
      const importedComps = versionDependenciesArr.map((c) => c.component.id.toStringWithoutVersion());
      Object.keys(beforeImportVersions).forEach((compIdStr) => {
        const found = importedComps.includes(compIdStr);
        if (!found) missingIds.push(compIdStr);
      });
    }

    return {
      importedIds: versionDependenciesArr.map((v) => v.component.id).flat(),
      importedDeps: versionDependenciesArr.map((v) => v.allDependenciesIds).flat(),
      writtenComponents,
      importDetails,
      installationError: componentWriterResults?.installationError,
      compilationError: componentWriterResults?.compilationError,
      missingIds,
    };
  }

  async importSpecificComponents(): Promise<ImportResult> {
    logger.debug(`importSpecificComponents, Ids: ${this.options.ids.join(', ')}`);
    const bitIds: ComponentIdList = await this.getBitIds();
    const beforeImportVersions = await this._getCurrentVersions(bitIds);
    await this._throwForPotentialIssues(bitIds);
    const versionDependenciesArr = await this._importComponentsObjects(bitIds, {
      lane: this.laneObjects?.[0],
    });
    if (this.laneObjects && this.options.objectsOnly) {
      // merge the lane objects
      const mergeAllLanesResults = await pMapSeries(this.laneObjects, (laneObject) =>
        this.scope.sources.mergeLane(laneObject, true)
      );
      const mergedLanes = mergeAllLanesResults.map((result) => result.mergeLane);
      await Promise.all(mergedLanes.map((mergedLane) => this.scope.lanes.saveLane(mergedLane)));
    }
    let writtenComponents: Component[] = [];
    let componentWriterResults: ComponentWriterResults | undefined;
    if (!this.options.objectsOnly) {
      const components = await multipleVersionDependenciesToConsumer(versionDependenciesArr, this.scope.objects);
      await this._fetchDivergeData(components);
      this._throwForDivergedHistory();
      await this.throwForComponentsFromAnotherLane(components.map((c) => c.id));
      const filteredComponents = await this._filterComponentsByFilters(components);
      componentWriterResults = await this._writeToFileSystem(filteredComponents);
      await this._saveLaneDataIfNeeded(filteredComponents);
      writtenComponents = filteredComponents;
    }

    return this.returnCompleteResults(
      beforeImportVersions,
      versionDependenciesArr,
      writtenComponents,
      componentWriterResults
    );
  }

  private async _filterComponentsByFilters(components: Component[]): Promise<Component[]> {
    if (!this.options.filterEnvs) return components;
    const filteredP = components.map(async (component) => {
      // If the id was requested explicitly, we don't want to filter it out
      if (this.options.ids) {
        if (
          this.options.ids.includes(component.id.toStringWithoutVersion()) ||
          this.options.ids.includes(component.id.toString())
        ) {
          return component;
        }
      }
      const currentEnv = await this.envs.calculateEnvIdFromExtensions(component.extensions);
      const currentEnvWithoutVersion = currentEnv.split('@')[0];
      if (
        this.options.filterEnvs?.includes(currentEnv) ||
        this.options.filterEnvs?.includes(currentEnvWithoutVersion)
      ) {
        return component;
      }
      return undefined;
    });
    const filtered = compact(await Promise.all(filteredP));
    return filtered;
  }

  async _fetchDivergeData(components: Component[]) {
    if (this.options.objectsOnly) {
      // no need for it when importing objects only. if it's enabled, in case when on a lane and a non-lane
      // component is in bitmap using an older version, it throws "getDivergeData: unable to find Version X of Y"
      return;
    }
    await Promise.all(
      components.map(async (component) => {
        const modelComponent = await this.scope.getModelComponent(component.id);
        await modelComponent.setDivergeData(this.scope.objects, undefined, false);
        this.divergeData.push(modelComponent);
      })
    );
  }

  _throwForDivergedHistory() {
    if (this.options.merge || this.options.objectsOnly) return;
    const divergedComponents = this.divergeData.filter((modelComponent) =>
      modelComponent.getDivergeData().isDiverged()
    );
    if (divergedComponents.length) {
      const divergeData = divergedComponents.map((modelComponent) => ({
        id: modelComponent.id(),
        snapsLocal: modelComponent.getDivergeData().snapsOnSourceOnly.length,
        snapsRemote: modelComponent.getDivergeData().snapsOnTargetOnly.length,
      }));
      throw new ComponentsPendingMerge(divergeData);
    }
  }

  private async throwForComponentsFromAnotherLane(bitIds: ComponentID[]) {
    if (this.options.objectsOnly) return;
    const currentLaneId = this.workspace.getCurrentLaneId();
    const currentRemoteLane = currentLaneId
      ? this.options.lanes?.lanes.find((l) => l.toLaneId().isEqual(currentLaneId))
      : undefined;
    const currentLane = await this.workspace.getCurrentLaneObject();
    const idsFromAnotherLane: ComponentID[] = [];
    if (currentRemoteLane) {
      await Promise.all(
        bitIds.map(async (bitId) => {
          const isOnCurrentLane =
            (await this.scope.isPartOfLaneHistory(bitId, currentRemoteLane)) ||
            (currentLane && (await this.scope.isPartOfLaneHistory(bitId, currentLane))) ||
            (await this.scope.isPartOfMainHistory(bitId));
          if (!isOnCurrentLane) idsFromAnotherLane.push(bitId);
        })
      );
    } else {
      await Promise.all(
        bitIds.map(async (bitId) => {
          const isIdOnMain = await this.scope.isPartOfMainHistory(bitId);
          if (!isIdOnMain) idsFromAnotherLane.push(bitId);
        })
      );
    }
    if (idsFromAnotherLane.length) {
      throw new BitError(`unable to import the following component(s) as they belong to other lane(s):
${idsFromAnotherLane.map((id) => id.toString()).join(', ')}
if you need this specific snap, find the lane this snap is belong to, then run "bit lane merge <lane-id> [component-id]" to merge this component from the lane.
`);
    }
  }

  private async _importComponentsObjects(
    ids: ComponentIdList,
    {
      fromOriginalScope = false,
      lane,
      ignoreMissingHead = false,
    }: {
      fromOriginalScope?: boolean;
      lane?: Lane;
      ignoreMissingHead?: boolean;
    }
  ): Promise<VersionDependencies[]> {
    const scopeComponentsImporter = ScopeComponentsImporter.getInstance(this.scope);
    await scopeComponentsImporter.importWithoutDeps(ids.toVersionLatest(), {
      cache: false,
      lane,
      includeVersionHistory: true,
      fetchHeadIfLocalIsBehind: !this.options.allHistory,
      collectParents: this.options.allHistory,
      // in case a user is merging a lane into a new workspace, then, locally main has head, but remotely the head is
      // empty, until it's exported. going to the remote and asking this component will throw an error if ignoreMissingHead is false
      ignoreMissingHead: true,
      includeUnexported: this.options.isLaneFromRemote,
      reason: `of their latest on ${lane ? `lane ${lane.id()}` : 'main'}`,
    });

    loader.start(`import ${ids.length} components with their dependencies (if missing)`);
    const results = fromOriginalScope
      ? await scopeComponentsImporter.importManyFromOriginalScopes(ids)
      : await scopeComponentsImporter.importMany({
          ids,
          ignoreMissingHead,
          lane,
          preferDependencyGraph: !this.options.fetchDeps,
          // when user is running "bit import", we want to re-fetch if it wasn't built. todo: check if this can be disabled when not needed
          reFetchUnBuiltVersion: true,
          // it's possible that .bitmap is not in sync and has local tags that don't exist on the remote. later, we
          // add them to "missingIds" of "importResult" and show them to the user
          throwForSeederNotFound: false,
          reason: this.options.fetchDeps
            ? 'for getting all dependencies'
            : `for getting dependencies of components that don't have dependency-graph`,
        });

    return results;
  }

  /**
   * consider the following use cases:
   * 1) no ids were provided. it should import all the lanes components objects AND main components objects
   * (otherwise, if main components are not imported and are missing, then bit-status complains about it)
   * 2) ids are provided with wildcards. we assume the user wants only the ids that are available on the lane.
   * because a user may entered "bit import scope/*" and this scope has many component on the lane and many not on the lane.
   * we want to bring only the components on the lane.
   * 3) ids are provided without wildcards. here, the user knows exactly what's needed and it's ok to get the ids from
   * main if not found on the lane.
   */
  private async getBitIdsForLanes(): Promise<ComponentID[]> {
    if (!this.options.lanes) {
      throw new Error(`getBitIdsForLanes: this.options.lanes must be set`);
    }
    const bitIdsFromLane = ComponentIdList.fromArray(this.laneObjects.flatMap((lane) => lane.toBitIds()));

    if (!this.options.ids.length) {
      const bitMapIds = this.consumer.bitMap.getAllBitIds();
      const bitMapIdsToImport = bitMapIds.filter((id) => id.hasScope() && !bitIdsFromLane.has(id));
      bitIdsFromLane.push(...bitMapIdsToImport);

      return bitIdsFromLane;
    }

    const idsWithWildcard = this.options.ids.filter((id) => hasWildcard(id));
    const idsWithoutWildcard = this.options.ids.filter((id) => !hasWildcard(id));
    const idsWithoutWildcardPreferFromLane = idsWithoutWildcard.map((idStr) => {
      const id = ComponentID.fromString(idStr);
      const fromLane = bitIdsFromLane.searchWithoutVersion(id);
      return fromLane && !id.hasVersion() ? fromLane : id;
    });

    const bitIds: ComponentID[] = [...idsWithoutWildcardPreferFromLane];

    if (!idsWithWildcard) {
      return bitIds;
    }

    await pMapSeries(idsWithWildcard, async (idStr: string) => {
      const idsFromRemote = await getRemoteBitIdsByWildcards(idStr, this.options.includeDeprecated);
      const existingOnLanes = idsFromRemote.filter((id) => bitIdsFromLane.hasWithoutVersion(id));
      if (!existingOnLanes.length) {
        throw new BitError(`the id with the the wildcard "${idStr}" has been parsed to multiple component ids.
however, none of them existing on the lane "${this.laneObjects.map((l) => l.name).join(', ')}"
in case you intend to import these components from main, please run the following:
bit import ${idsFromRemote.map((id) => id.toStringWithoutVersion()).join(' ')}`);
      }
      bitIds.push(...existingOnLanes);
    });

    return bitIds;
  }

  private async getBitIdsForNonLanes() {
    const bitIds: ComponentID[] = [];
    await Promise.all(
      this.options.ids.map(async (idStr: string) => {
        if (hasWildcard(idStr)) {
          const ids = await getRemoteBitIdsByWildcards(idStr, this.options.includeDeprecated);
          loader.start(BEFORE_IMPORT_ACTION); // it stops the previous loader of BEFORE_REMOTE_LIST
          bitIds.push(...ids);
        } else {
          bitIds.push(ComponentID.fromString(idStr)); // we don't support importing without a scope name
        }
      })
    );

    return bitIds;
  }

  private async getBitIds(): Promise<ComponentIdList> {
    const bitIds: ComponentID[] = this.options.lanes
      ? await this.getBitIdsForLanes()
      : await this.getBitIdsForNonLanes();
    if (this.options.importDependenciesDirectly || this.options.importDependents) {
      if (this.options.importDependenciesDirectly) {
        const dependenciesIds = await this.getFlattenedDepsUnique(bitIds);
        bitIds.push(...dependenciesIds);
      }
      if (this.options.importDependents) {
        const graph = await this.graph.getGraphIds();
        const targetCompIds = await this.workspace.resolveMultipleComponentIds(bitIds);
        const sourceIds = await this.workspace.listIds();
        const ids = graph.findIdsFromSourcesToTargets(sourceIds, targetCompIds);
        logger.debug(
          `found ${ids.length} component for --dependents flag`,
          ids.map((id) => id.toString())
        );
        bitIds.push(...ids.map((id) => id));
      }
    }
    return ComponentIdList.uniqFromArray(bitIds);
  }

  private async getFlattenedDepsUnique(bitIds: ComponentID[]): Promise<ComponentID[]> {
    const remoteComps = await this.scope.scopeImporter.getManyRemoteComponents(bitIds);
    const versions = remoteComps.getVersions();
    const getFlattened = (): ComponentIdList => {
      if (versions.length === 1) return versions[0].flattenedDependencies;
      const flattenedDeps = versions.map((v) => v.flattenedDependencies).flat();
      return ComponentIdList.uniqFromArray(flattenedDeps);
    };
    const flattened = getFlattened();
    const withLatest = this.removeMultipleVersionsKeepLatest(flattened);
    return withLatest;
  }

  private removeMultipleVersionsKeepLatest(flattened: ComponentIdList): ComponentID[] {
    const grouped = flattened.toGroupByIdWithoutVersion();
    const latestVersions = Object.keys(grouped).map((key) => {
      const ids = grouped[key];
      if (ids.length === 1) return ids[0];
      const latest = getLatestVersionNumber(ids, ids[0].changeVersion(LATEST_VERSION));
      return latest;
    });

    return latestVersions;
  }

  async importAccordingToBitMap(): Promise<ImportResult> {
    this.options.objectsOnly = !this.options.merge && !this.options.override;
    const componentsIdsToImport = this.getIdsToImportFromBitmap();
    const emptyResult = {
      importedIds: [],
      importedDeps: [],
      importDetails: [],
    };
    if (R.isEmpty(componentsIdsToImport)) {
      return emptyResult;
    }
    await this._throwForModifiedOrNewComponents(componentsIdsToImport);
    const beforeImportVersions = await this._getCurrentVersions(componentsIdsToImport);
    if (!componentsIdsToImport.length) {
      return emptyResult;
    }
    if (!this.options.objectsOnly) {
      throw new Error(`bit import with no ids and --merge flag was not implemented yet`);
    }
    const versionDependenciesArr = await this._importComponentsObjects(componentsIdsToImport, {
      fromOriginalScope: this.options.fromOriginalScope,
    });
    let writtenComponents: Component[] = [];
    let componentWriterResults: ComponentWriterResults | undefined;
    if (!this.options.objectsOnly) {
      const components = await multipleVersionDependenciesToConsumer(versionDependenciesArr, this.scope.objects);
      componentWriterResults = await this._writeToFileSystem(components);
      writtenComponents = components;
    }

    return this.returnCompleteResults(
      beforeImportVersions,
      versionDependenciesArr,
      writtenComponents,
      componentWriterResults
    );
  }

  private getIdsToImportFromBitmap() {
    const allIds = this.consumer.bitMap.getAllBitIdsFromAllLanes();
    return ComponentIdList.fromArray(allIds.filter((id) => id.hasScope()));
  }

  async _getCurrentVersions(ids: ComponentIdList): Promise<ImportedVersions> {
    const versionsP = ids.map(async (id) => {
      const modelComponent = await this.consumer.scope.getModelComponentIfExist(id.changeVersion(undefined));
      const idStr = id.toStringWithoutVersion();
      if (!modelComponent) return [idStr, []];
      return [idStr, modelComponent.listVersions()];
    });
    const versions = await Promise.all(versionsP);
    return R.fromPairs(versions);
  }

  /**
   * get import details, includes the diff between the versions array before import and after import
   */
  async _getImportDetails(
    currentVersions: ImportedVersions,
    components: VersionDependencies[]
  ): Promise<ImportDetails[]> {
    const detailsP = components.map(async (component) => {
      const id = component.component.id;
      const idStr = id.toStringWithoutVersion();
      const beforeImportVersions = currentVersions[idStr];
      if (!beforeImportVersions) {
        throw new Error(
          `_getImportDetails failed finding ${idStr} in currentVersions, which has ${Object.keys(currentVersions).join(
            ', '
          )}`
        );
      }
      const modelComponent = await this.consumer.scope.getModelComponentIfExist(id);
      if (!modelComponent) throw new BitError(`imported component ${idStr} was not found in the model`);
      const afterImportVersions = modelComponent.listVersions();
      const versionDifference: string[] = R.difference(afterImportVersions, beforeImportVersions);
      const getStatus = (): ImportStatus => {
        if (!versionDifference.length) return 'up to date';
        if (!beforeImportVersions.length) return 'added';
        return 'updated';
      };
      const filesStatus = this.mergeStatus && this.mergeStatus[idStr] ? this.mergeStatus[idStr] : null;
      const deprecated = await modelComponent.isDeprecated(this.scope.objects);
      const removed = await component.component.component.isRemoved(this.scope.objects);
      const latestVersion = modelComponent.getHeadRegardlessOfLaneAsTagOrHash(true);
      return {
        id: idStr,
        versions: versionDifference,
        latestVersion: versionDifference.includes(latestVersion) ? latestVersion : null,
        status: getStatus(),
        filesStatus,
        missingDeps: this.options.fetchDeps ? component.getMissingDependencies() : [],
        deprecated,
        removed,
      };
    });
    const importDetails: ImportDetails[] = await Promise.all(detailsP);

    return importDetails;
  }

  async _throwForPotentialIssues(ids: ComponentIdList): Promise<void> {
    await this._throwForModifiedOrNewComponents(ids);
    this._throwForDifferentComponentWithSameName(ids);
  }

  async _throwForModifiedOrNewComponents(ids: ComponentIdList): Promise<void> {
    // the typical objectsOnly option is when a user cloned a project with components tagged to the source code, but
    // doesn't have the model objects. in that case, calling getComponentStatusById() may return an error as it relies
    // on the model objects when there are dependencies
    if (this.options.override || this.options.objectsOnly || this.options.merge || this.options.trackOnly) return;
    const componentsStatuses = await this.consumer.getManyComponentsStatuses(ids);
    const modifiedComponents = componentsStatuses
      .filter(({ status }) => status.modified || status.newlyCreated)
      .map((c) => c.id);
    if (modifiedComponents.length) {
      throw new GeneralError(
        chalk.yellow(
          `unable to import the following components due to local changes, use --merge flag to merge your local changes or --override to override them\n${modifiedComponents.join(
            '\n'
          )} `
        )
      );
    }
  }

  /**
   * Model Component id() calculation uses id.toString() for the hash.
   * If an imported component has scopereadonly name equals to a local name, both will have the exact same
   * hash and they'll override each other.
   */
  _throwForDifferentComponentWithSameName(ids: ComponentIdList): void {
    ids.forEach((id: ComponentID) => {
      const existingId = this.consumer.getParsedIdIfExist(id.toStringWithoutVersion());
      if (existingId && !existingId.hasScope()) {
        throw new GeneralError(`unable to import ${id.toString()}. the component name conflicted with your local component with the same name.
        it's fine to have components with the same name as long as their scope names are different.
        Make sure to export your component first to get a scope and then try importing again`);
      }
    });
  }

  async _getMergeStatus(component: Component): Promise<ComponentMergeStatus> {
    const componentStatus = await this.consumer.getComponentStatusById(component.id);
    const mergeStatus: ComponentMergeStatus = { component, mergeResults: null };
    if (!componentStatus.modified) return mergeStatus;
    const componentModel = await this.consumer.scope.getModelComponent(component.id);
    const existingBitMapBitId = this.consumer.bitMap.getComponentId(component.id, { ignoreVersion: true });
    // TODO: check if we really need the { loadExtensions: true } here
    const fsComponent = await this.consumer.loadComponent(existingBitMapBitId, { loadExtensions: true });
    const currentlyUsedVersion = existingBitMapBitId.version;
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    const baseComponent: Version = await componentModel.loadVersion(currentlyUsedVersion, this.consumer.scope.objects);
    const otherComponent: Version = await componentModel.loadVersion(
      // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
      component.id.version,
      this.consumer.scope.objects
    );
    const mergeResults = await threeWayMerge({
      consumer: this.consumer,
      otherComponent,
      otherLabel: component.id.version as string,
      currentComponent: fsComponent,
      currentLabel: `${currentlyUsedVersion} modified`,
      baseComponent,
    });
    mergeStatus.mergeResults = mergeResults;
    return mergeStatus;
  }

  /**
   * 1) when there are conflicts and the strategy is "ours", don't write the imported component to
   * the filesystem, only update bitmap.
   *
   * 2) when there are conflicts and the strategy is "theirs", override the local changes by the
   * imported component. (similar to --override)
   *
   * 3) when there is no conflict or there are conflicts and the strategy is manual, write the files
   * according to the merge result. (done by applyModifiedVersion())
   */
  _updateComponentFilesPerMergeStrategy(componentMergeStatus: ComponentMergeStatus): FilesStatus | null | undefined {
    const mergeResults = componentMergeStatus.mergeResults;
    if (!mergeResults) return null;
    const component = componentMergeStatus.component;
    const files = component.files;

    if (mergeResults.hasConflicts && this.options.mergeStrategy === MergeOptions.ours) {
      const filesStatus = {};
      // don't write the files to the filesystem, only bump the bitmap version.
      files.forEach((file) => {
        // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
        filesStatus[pathNormalizeToLinux(file.relative)] = FileStatus.unchanged;
      });
      this.consumer.bitMap.updateComponentId(component.id);
      this.consumer.bitMap.hasChanged = true;
      return filesStatus;
    }
    if (mergeResults.hasConflicts && this.options.mergeStrategy === MergeOptions.theirs) {
      const filesStatus = {};
      // the local changes will be overridden (as if the user entered --override flag for this component)
      files.forEach((file) => {
        // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
        filesStatus[pathNormalizeToLinux(file.relative)] = FileStatus.updated;
      });
      return filesStatus;
    }
    const { filesStatus, modifiedFiles } = applyModifiedVersion(
      component.files,
      mergeResults,
      this.options.mergeStrategy
    );
    component.files = modifiedFiles;

    return filesStatus;
  }

  /**
   * update the component files if they are modified and there is a merge strategy.
   * returns only the components that need to be written to the filesystem
   */
  async updateAllComponentsAccordingToMergeStrategy(components: Component[]): Promise<Component[]> {
    if (!this.options.merge) return components;
    const componentsStatusP = components.map((component: Component) => {
      return this._getMergeStatus(component);
    });
    const componentsStatus = await Promise.all(componentsStatusP);
    const componentWithConflict = componentsStatus.find(
      (component) => component.mergeResults && component.mergeResults.hasConflicts
    );
    if (componentWithConflict && !this.options.mergeStrategy) {
      this.options.mergeStrategy = await getMergeStrategyInteractive();
    }
    this.mergeStatus = {};

    const componentsToWrite = componentsStatus.map((componentStatus) => {
      const filesStatus: FilesStatus | null | undefined = this._updateComponentFilesPerMergeStrategy(componentStatus);
      const component = componentStatus.component;
      if (!filesStatus) return component;
      this.mergeStatus[component.id.toStringWithoutVersion()] = filesStatus;
      const unchangedFiles = Object.keys(filesStatus).filter((file) => filesStatus[file] === FileStatus.unchanged);
      if (unchangedFiles.length === Object.keys(filesStatus).length) {
        // all files are unchanged
        return null;
      }
      return component;
    });
    const removeNulls = R.reject(R.isNil);
    return removeNulls(componentsToWrite);
  }

  _shouldSaveLaneData(): boolean {
    if (this.options.objectsOnly) {
      return false;
    }
    return this.consumer.isOnLane();
  }

  async _saveLaneDataIfNeeded(components: Component[]): Promise<void> {
    if (!this._shouldSaveLaneData()) {
      return;
    }
    const currentLane = await this.consumer.getCurrentLaneObject();
    if (!currentLane) {
      return; // user on main
    }
    const idsFromRemoteLanes = ComponentIdList.fromArray(this.laneObjects.flatMap((lane) => lane.toBitIds()));
    await Promise.all(
      components.map(async (comp) => {
        const existOnRemoteLane = idsFromRemoteLanes.has(comp.id);
        if (!existOnRemoteLane && !this.options.saveInLane) {
          this.consumer.bitMap.setOnLanesOnly(comp.id, false);
          return;
        }
        const modelComponent = await this.scope.getModelComponent(comp.id);
        const ref = modelComponent.getRef(comp.id.version as string);
        if (!ref) throw new Error(`_saveLaneDataIfNeeded unable to get ref for ${comp.id.toString()}`);
        currentLane.addComponent({ id: comp.id, head: ref });
      })
    );
    await this.scope.lanes.saveLane(currentLane);
  }

  async _writeToFileSystem(components: Component[]): Promise<ComponentWriterResults> {
    const componentsToWrite = await this.updateAllComponentsAccordingToMergeStrategy(components);
    const manyComponentsWriterOpts: ManyComponentsWriterParams = {
      components: componentsToWrite,
      writeToPath: this.options.writeToPath,
      writeConfig: this.options.writeConfig,
      skipDependencyInstallation: !this.options.installNpmPackages,
      skipWriteConfigFiles: !this.options.writeConfigFiles,
      verbose: this.options.verbose,
      throwForExistingDir: !this.options.override,
      skipWritingToFs: this.options.trackOnly,
      reasonForBitmapChange: 'import',
    };
    return this.componentWriter.writeMany(manyComponentsWriterOpts);
  }
}
