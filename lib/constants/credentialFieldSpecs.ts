import { type SupportedPlatform } from '@/lib/constants';

interface CredentialFieldSpec {
  identifierKey: string;
  identifierLabel: string;
  secretFields: { key: string; label: string }[];
}

export const credentialFieldSpecs = {
  ebay: {
    identifierKey: 'username',
    identifierLabel: 'eBay username',
    secretFields: [
      { key: 'apiKey', label: 'API Key' },
      { key: 'apiSecret', label: 'API Secret' },
    ],
  },
  etsy: {
    identifierKey: 'shopName',
    identifierLabel: 'Etsy shop name',
    secretFields: [
      { key: 'apiKey', label: 'API Key' },
      { key: 'apiSecret', label: 'API Secret' },
    ],
  },
  amazon: {
    identifierKey: 'sellerId',
    identifierLabel: 'Amazon Seller ID',
    secretFields: [
      { key: 'apiKey', label: 'API Key' },
      { key: 'apiSecret', label: 'API Secret' },
    ],
  },
  poshmark: {
    identifierKey: 'username',
    identifierLabel: 'Poshmark username',
    secretFields: [
      { key: 'password', label: 'Password' },
    ],
  },
  depop: {
    identifierKey: 'username',
    identifierLabel: 'Depop username',
    secretFields: [
      { key: 'password', label: 'Password' },
    ],
  },
  mercari: {
    identifierKey: 'username',
    identifierLabel: 'Mercari username',
    secretFields: [
      { key: 'password', label: 'Password' },
    ],
  },
  vinted: {
    identifierKey: 'username',
    identifierLabel: 'Vinted username',
    secretFields: [
      { key: 'password', label: 'Password' },
    ],
  },
  grailed: {
    identifierKey: 'username',
    identifierLabel: 'Grailed username',
    secretFields: [
      { key: 'password', label: 'Password' },
    ],
  },
  swappa: {
    identifierKey: 'username',
    identifierLabel: 'Swappa username',
    secretFields: [
      { key: 'password', label: 'Password' },
    ],
  },
} as const satisfies Record<SupportedPlatform, CredentialFieldSpec>;
