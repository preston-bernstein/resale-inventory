// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrandCombobox, rankByFrequency, moveHighlightIndex, buildComboOptions } from '../BrandCombobox';

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

describe('rankByFrequency', () => {
  it('sorts brands matching the frequency list earlier, in frequency order', () => {
    const filtered = [
      { id: '1', canonical_name: 'Zara' },
      { id: '2', canonical_name: 'Nike' },
      { id: '3', canonical_name: 'Adidas' },
    ];
    const result = rankByFrequency(filtered, ['nike', 'zara']);
    expect(result.map(b => b.canonical_name)).toEqual(['Nike', 'Zara', 'Adidas']);
  });

  it('sorts unmatched brands alphabetically after matched ones', () => {
    const filtered = [
      { id: '1', canonical_name: 'Zara' },
      { id: '2', canonical_name: 'Adidas' },
      { id: '3', canonical_name: 'Nike' },
    ];
    const result = rankByFrequency(filtered, ['nike']);
    expect(result.map(b => b.canonical_name)).toEqual(['Nike', 'Adidas', 'Zara']);
  });

  it('is case-insensitive when matching against the frequency list', () => {
    const filtered = [{ id: '1', canonical_name: 'Nike' }];
    const result = rankByFrequency(filtered, ['NIKE']);
    expect(result.map(b => b.canonical_name)).toEqual(['Nike']);
  });

  it('with an empty frequency list, falls back to pure alphabetical order', () => {
    const filtered = [
      { id: '1', canonical_name: 'Zara' },
      { id: '2', canonical_name: 'Adidas' },
    ];
    const result = rankByFrequency(filtered, []);
    expect(result.map(b => b.canonical_name)).toEqual(['Adidas', 'Zara']);
  });

  it('with an empty filtered list, returns an empty list', () => {
    expect(rankByFrequency([], ['nike'])).toEqual([]);
  });
});

describe('BrandCombobox keyboard interactions', () => {
  it('ArrowDown opens the listbox and highlights the first option', async () => {
    stubFetch([
      { id: '1', canonical_name: 'Adidas' },
      { id: '2', canonical_name: 'Nike' },
    ]);
    const user = userEvent.setup();
    renderCombobox();

    const input = screen.getByRole('combobox');
    await user.type(input, 'a');
    await screen.findByRole('option', { name: 'Adidas' });

    await user.keyboard('{ArrowDown}');
    const first = screen.getAllByRole('option')[0];
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('ArrowDown then ArrowUp returns the highlight to the previous option', async () => {
    stubFetch([
      { id: '1', canonical_name: 'Adidas' },
      { id: '2', canonical_name: 'Adidog' },
    ]);
    const user = userEvent.setup();
    renderCombobox();

    const input = screen.getByRole('combobox');
    await user.type(input, 'ad');
    await screen.findByRole('option', { name: 'Adidas' });

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}');
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'false');
  });

  it('ArrowDown past the last option stays on the last option (no wraparound)', async () => {
    stubFetch([{ id: '1', canonical_name: 'Adidas' }]);
    const user = userEvent.setup();
    renderCombobox();

    const input = screen.getByRole('combobox');
    await user.type(input, 'a');
    await screen.findByRole('option', { name: 'Adidas' });

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true');
  });

  it('Enter with an option highlighted selects it and closes the listbox', async () => {
    stubFetch([{ id: '1', canonical_name: 'Adidas' }]);
    const user = userEvent.setup();
    const { onChange } = renderCombobox();

    const input = screen.getByRole('combobox');
    await user.type(input, 'a');
    await screen.findByRole('option', { name: 'Adidas' });

    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('Adidas');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('Escape closes the listbox without changing the typed value', async () => {
    stubFetch([{ id: '1', canonical_name: 'Adidas' }]);
    const user = userEvent.setup();
    const { onChange } = renderCombobox();
    onChange.mockClear();

    const input = screen.getByRole('combobox');
    await user.type(input, 'a');
    await screen.findByRole('option', { name: 'Adidas' });

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalledWith('Adidas');
  });

  it('Escape with the listbox already closed is a no-op', async () => {
    stubFetch([]);
    const user = userEvent.setup();
    renderCombobox();

    const input = screen.getByRole('combobox');
    input.blur();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('buildComboOptions', () => {
  it('maps each ranked brand to a non-add-new option in order', () => {
    const ranked = [
      { id: '1', canonical_name: 'Adidas' },
      { id: '2', canonical_name: 'Nike' },
    ];
    const options = buildComboOptions(ranked, 'nik', true);
    expect(options).toEqual([
      { key: '1', label: 'Adidas', value: 'Adidas', isAddNew: false },
      { key: '2', label: 'Nike', value: 'Nike', isAddNew: false },
    ]);
  });

  it('appends an "Add new brand" option when there is no exact match and typed text is non-empty', () => {
    const options = buildComboOptions([], 'Stussy', false);
    expect(options).toEqual([
      { key: '__add-new__', label: 'Add "Stussy" as a new brand', value: 'Stussy', isAddNew: true },
    ]);
  });

  it('omits the "Add new brand" option when there is an exact match', () => {
    const ranked = [{ id: '1', canonical_name: 'Nike' }];
    const options = buildComboOptions(ranked, 'Nike', true);
    expect(options).toEqual([{ key: '1', label: 'Nike', value: 'Nike', isAddNew: false }]);
  });

  it('omits the "Add new brand" option when the typed value is empty', () => {
    expect(buildComboOptions([], '', false)).toEqual([]);
  });
});

describe('moveHighlightIndex', () => {
  it('moving down from -1 (nothing highlighted) lands on index 0', () => {
    expect(moveHighlightIndex(-1, 'down', 3)).toBe(0);
  });

  it('moving down stops at the last index (no wraparound)', () => {
    expect(moveHighlightIndex(2, 'down', 3)).toBe(2);
  });

  it('moving up from index 0 stays at 0 (no wraparound)', () => {
    expect(moveHighlightIndex(0, 'up', 3)).toBe(0);
  });

  it('moving up from index 2 lands on index 1', () => {
    expect(moveHighlightIndex(2, 'up', 3)).toBe(1);
  });

  it('with zero options, always returns -1 regardless of direction', () => {
    expect(moveHighlightIndex(-1, 'down', 0)).toBe(-1);
    expect(moveHighlightIndex(-1, 'up', 0)).toBe(-1);
  });
});
