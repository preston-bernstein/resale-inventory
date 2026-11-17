// @vitest-environment jsdom
import { afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { BrandCombobox } from '../BrandCombobox';
import { describeKeyboardContract } from './comboboxKeyboardContract';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stubFetch(brands: { id: string; canonical_name: string }[], frequency: string[] = []) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/brands')) {
      return { ok: true, status: 200, json: async () => ({ brands }) } as Response;
    }
    if (url.startsWith('/api/items/suggestions')) {
      return { ok: true, status: 200, json: async () => ({ values: frequency }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderCombobox(initial = '') {
  let value = initial;
  const onChange = vi.fn((v: string) => {
    value = v;
  });
  const utils = render(<BrandCombobox value={value} onChange={onChange} />);
  return { ...utils, onChange };
}

describeKeyboardContract({
  name: 'BrandCombobox',
  stubItems: (names) => stubFetch(names.map((canonical_name, i) => ({ id: String(i + 1), canonical_name }))),
  renderCombobox,
  first: 'Adidas',
  second: 'Adidog',
  prefix: 'ad',
});
