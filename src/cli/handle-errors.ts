import { serializeError } from 'serialize-error';
import logger from '../logger/logger';
import { buildCommandMessage, isNumeric, packCommand } from '../utils';
import defaultHandleError from './default-error-handler';
import loader from './loader';

export async function handleErrorAndExit(err: Error, commandName: string, shouldSerialize = false): Promise<void> {
  try {
    loader.off();
    logger.error(`got an error from command ${commandName}: ${err}`, err);
    const { message, error } = defaultHandleError(err);
    if (shouldSerialize) serializeErrAndExit(error, commandName);
    else await logErrAndExit(message, commandName, err);
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error('failed to log the error properly, failure error', e);
    // eslint-disable-next-line no-console
    console.error('failed to log the error properly, original error', err);
    process.exit(1);
  }
}

export async function handleUnhandledRejection(err: Error | null | undefined | {}) {
  // eslint-disable-next-line no-console
  console.error('** unhandled rejection found, please make sure the promise is resolved/rejected correctly! **');
  if (err instanceof Error) {
    return handleErrorAndExit(err, process.argv[2]);
  }
  console.error(err); // eslint-disable-line
  return handleErrorAndExit(new Error(`unhandledRejections found. err ${err}`), process.argv[2]);
}

async function logErrAndExit(errMsg: Error | string, commandName: string, errObj: Error) {
  if (!errMsg) throw new Error(`logErrAndExit expects to get either an Error or a string, got nothing`);
  console.error(errMsg); // eslint-disable-line
  // for CI, print the entire error with the stacktrace
  if (process.env.CI) console.error(errObj); // eslint-disable-line
  await logger.exitAfterFlush(1, commandName, errMsg.toString());
}

function serializeErrAndExit(err, commandName: string) {
  const data = packCommand(buildCommandMessage(serializeError(err), undefined, false), false, false);
  const code = err.code && isNumeric(err.code) ? err.code : 1;
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  return process.stderr.write(data, () => logger.exitAfterFlush(code, commandName));
}
