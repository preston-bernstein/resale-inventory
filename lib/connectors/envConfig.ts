import { ConnectorNotConfiguredError } from './types';

/**
 * Require an environment variable to be set. Throws ConnectorNotConfiguredError
 * at call time if the variable is not found, ensuring that one platform's
 * missing configuration does not prevent other modules from loading.
 *
 * @param platform The platform name (e.g. 'ebay', 'etsy')
 * @param varName The environment variable name to require
 * @returns The environment variable value
 * @throws ConnectorNotConfiguredError if the variable is not set
 */
export function requireEnv(platform: string, varName: string): string {
  const value = process.env[varName];
  if (!value) {
    throw new ConnectorNotConfiguredError(platform, varName);
  }
  return value;
}
