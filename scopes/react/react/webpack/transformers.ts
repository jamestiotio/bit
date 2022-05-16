import findRoot from 'find-root';
import { realpathSync } from 'fs';
import { WebpackConfigTransformContext } from '@teambit/webpack';
import { WebpackConfigMutator } from '@teambit/webpack.modules.config-mutator';
import { Logger } from '@teambit/logger';
import { getExposedRules } from './get-exposed-rules';

export function generateAddAliasesFromPeersTransformer(peers: string[], logger: Logger) {
  return (config: WebpackConfigMutator, context: WebpackConfigTransformContext): WebpackConfigMutator => {
    const hostRootDir = context.target?.hostRootDir || context.hostRootDir;
    const peerAliases = peers.reduce((acc, peerName) => {
      // gets the correct module folder of the package.
      // this allows us to resolve internal files, for example:
      // node_modules/react-dom/test-utils
      //
      // we can't use require.resolve() because it resolves to a specific file.
      // for example, if we used "react-dom": require.resolve("react-dom"),
      // it would try to resolve "react-dom/test-utils" as:
      // node_modules/react-dom/index.js/test-utils
      const resolved = getResolvedDirOrFile(peerName, logger, hostRootDir);
      if (resolved) {
        acc[peerName] = resolved;
      }
      return acc;
    }, {});
    config.addAliases(peerAliases);
    return config;
  };
}

/**
 * Get the package folder, and in case it's not found get the require.resolve path
 * @param peerName
 * @returns
 */
function getResolvedDirOrFile(peerName: string, logger: Logger, hostRootDir?: string): string | undefined {
  let resolved;
  try {
    let options;
    if (hostRootDir) {
      options = {
        // resolve the host root dir to its real location, as require.resolve is preserve symlink, so we get wrong result otherwise
        paths: [realpathSync(hostRootDir), __dirname],
      };
    }
    resolved = require.resolve(peerName, options);
    const folder = findRoot(resolved);
    return folder;
  } catch (e) {
    if (resolved) {
      logger.warn(`Couldn't find root dir for "${peerName}" from path "${resolved}" to add it as webpack alias`);
    } else {
      logger.warn(`Couldn't resolve "${peerName}" to add it as webpack alias`);
    }
    return resolved;
  }
}

/**
 * Generate a transformer that expose all the peers as global via the expose loader
 * @param peers
 * @returns
 */
export function generateExposePeersTransformer(peers: string[]) {
  return (config: WebpackConfigMutator, context: WebpackConfigTransformContext): WebpackConfigMutator => {
    const hostRootDir = context.target?.hostRootDir || context.hostRootDir;
    const exposedRules = getExposedRules(peers, hostRootDir);
    config.addModuleRules(exposedRules);
    return config;
  };
}
