import { describe, it, expect, afterEach } from 'vitest';
import { requireEnv } from '../envConfig';
import { ConnectorNotConfiguredError } from '../types';

describe('requireEnv', () => {
  const testVarName = 'TEST_CONNECTOR_VAR_12345';
  const anotherTestVarName = 'TEST_CONNECTOR_VAR_67890';

  afterEach(() => {
    // Clean up test environment variables
    delete process.env[testVarName];
    delete process.env[anotherTestVarName];
  });

  describe('ebay platform', () => {
    it('throws ConnectorNotConfiguredError when variable is not set', () => {
      // Ensure the variable is not set
      delete process.env[testVarName];

      expect(() => {
        requireEnv('ebay', testVarName);
      }).toThrow(ConnectorNotConfiguredError);

      // Verify the error has the correct properties
      try {
        requireEnv('ebay', testVarName);
      } catch (error) {
        if (error instanceof ConnectorNotConfiguredError) {
          expect(error.platform).toBe('ebay');
          expect(error.missingVar).toBe(testVarName);
        } else {
          throw error;
        }
      }
    });

    it('returns the value when variable is set', () => {
      const testValue = 'test-ebay-value-123';
      process.env[testVarName] = testValue;

      const result = requireEnv('ebay', testVarName);

      expect(result).toBe(testValue);
    });
  });

  describe('etsy platform', () => {
    it('throws ConnectorNotConfiguredError when variable is not set', () => {
      // Ensure the variable is not set
      delete process.env[anotherTestVarName];

      expect(() => {
        requireEnv('etsy', anotherTestVarName);
      }).toThrow(ConnectorNotConfiguredError);

      // Verify the error has the correct properties
      try {
        requireEnv('etsy', anotherTestVarName);
      } catch (error) {
        if (error instanceof ConnectorNotConfiguredError) {
          expect(error.platform).toBe('etsy');
          expect(error.missingVar).toBe(anotherTestVarName);
        } else {
          throw error;
        }
      }
    });

    it('returns the value when variable is set', () => {
      const testValue = 'test-etsy-value-456';
      process.env[anotherTestVarName] = testValue;

      const result = requireEnv('etsy', anotherTestVarName);

      expect(result).toBe(testValue);
    });
  });

  describe('poshmark platform', () => {
    it('throws ConnectorNotConfiguredError when variable is not set', () => {
      delete process.env[testVarName];

      expect(() => {
        requireEnv('poshmark', testVarName);
      }).toThrow(ConnectorNotConfiguredError);

      try {
        requireEnv('poshmark', testVarName);
      } catch (error) {
        if (error instanceof ConnectorNotConfiguredError) {
          expect(error.platform).toBe('poshmark');
          expect(error.missingVar).toBe(testVarName);
        } else {
          throw error;
        }
      }
    });

    it('returns the value when variable is set', () => {
      const testValue = 'test-poshmark-value-789';
      process.env[testVarName] = testValue;

      const result = requireEnv('poshmark', testVarName);

      expect(result).toBe(testValue);
    });
  });
});
