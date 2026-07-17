// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VocabCombobox, rankByFrequency, moveHighlightIndex, buildComboOptions } from '../VocabCombobox';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stubFetch(
  items: { id: string; canonical_name: string }[],
  frequency: string[] = [],
  endpoint = '/api/colors',
  responseKey = 'colors'
) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(endpoint)) {
      return { ok: true, status: 200, json: async () => ({ [responseKey]: items }) } as Response;
    }
    if (url.startsWith('/api/items/suggestions')) {
      return { ok: true, status: 200, json: async () => ({ values: frequency }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function Harness({
  initial,
  onChange,
  endpoint,
  responseKey,
  suggestionField,
  label,
  maxLength,
  required,
}: {
  initial: string;
  onChange: (v: string) => void;
  endpoint: string;
  responseKey: string;
  suggestionField: string;
  label: string;
  maxLength: number;
  required?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <VocabCombobox
      value={value}
      onChange={v => {
        onChange(v);
        setValue(v);
      }}
      endpoint={endpoint}
      responseKey={responseKey}
      suggestionField={suggestionField}
      label={label}
      maxLength={maxLength}
      required={required}
    />
  );
}

function renderCombobox(
  initial = '',
  props: Partial<{
    endpoint: string;
    responseKey: string;
    suggestionField: string;
    label: string;
    maxLength: number;
    required: boolean;
  }> = {}
) {
  const onChange = vi.fn();
  const utils = render(
    <Harness
      initial={initial}
      onChange={onChange}
      endpoint={props.endpoint ?? '/api/colors'}
      responseKey={props.responseKey ?? 'colors'}
      suggestionField={props.suggestionField ?? 'color'}
      label={props.label ?? 'Color'}
      maxLength={props.maxLength ?? 255}
      required={props.required}
    />
  );
  return { ...utils, onChange };
}

describe('rankByFrequency', () => {
  it('sorts items matching the frequency list earlier, in frequency order', () => {
    const filtered = [
      { id: '1', canonical_name: 'Blue' },
      { id: '2', canonical_name: 'Black' },
      { id: '3', canonical_name: 'Beige' },
    ];
    const result = rankByFrequency(filtered, ['black', 'blue']);
    expect(result.map(b => b.canonical_name)).toEqual(['Black', 'Blue', 'Beige']);
  });

  it('sorts unmatched items alphabetically after matched ones', () => {
    const filtered = [
      { id: '1', canonical_name: 'Blue' },
      { id: '2', canonical_name: 'Beige' },
      { id: '3', canonical_name: 'Black' },
    ];
    const result = rankByFrequency(filtered, ['black']);
    expect(result.map(b => b.canonical_name)).toEqual(['Black', 'Beige', 'Blue']);
  });

  it('is case-insensitive when matching against the frequency list', () => {
    const filtered = [{ id: '1', canonical_name: 'Black' }];
    const result = rankByFrequency(filtered, ['BLACK']);
    expect(result.map(b => b.canonical_name)).toEqual(['Black']);
  });

  it('with an empty frequency list, falls back to pure alphabetical order', () => {
    const filtered = [
      { id: '1', canonical_name: 'Blue' },
      { id: '2', canonical_name: 'Beige' },
    ];
    const result = rankByFrequency(filtered, []);
    expect(result.map(b => b.canonical_name)).toEqual(['Beige', 'Blue']);
  });

  it('with an empty filtered list, returns an empty list', () => {
    expect(rankByFrequency([], ['black'])).toEqual([]);
  });
});

describe('VocabCombobox keyboard interactions', () => {
  it('ArrowDown opens the listbox and highlights the first option', async () => {
    stubFetch([
      { id: '1', canonical_name: 'Black' },
      { id: '2', canonical_name: 'Blue' },
    ]);
    const user = userEvent.setup();
    renderCombobox();

    const input = screen.getByRole('combobox');
    await user.type(input, 'bl');
    await screen.findByRole('option', { name: 'Black' });

    await user.keyboard('{ArrowDown}');
    const first = screen.getAllByRole('option')[0];
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('ArrowDown then ArrowUp returns the highlight to the previous option', async () => {
    stubFetch([
      { id: '1', canonical_name: 'Black' },
      { id: '2', canonical_name: 'Blue' },
    ]);
    const user = userEvent.setup();
    renderCombobox();

    const input = screen.getByRole('combobox');
    await user.type(input, 'bl');
    await screen.findByRole('option', { name: 'Black' });

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}');
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'false');
  });

  it('ArrowDown past the last option stays on the last option (no wraparound)', async () => {
    stubFetch([{ id: '1', canonical_name: 'Black' }]);
    const user = userEvent.setup();
    renderCombobox();

    const input = screen.getByRole('combobox');
    await user.type(input, 'black');
    await screen.findByRole('option', { name: 'Black' });

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true');
  });

  it('Enter with an option highlighted selects it and closes the listbox', async () => {
    stubFetch([{ id: '1', canonical_name: 'Black' }]);
    const user = userEvent.setup();
    const { onChange } = renderCombobox();

    const input = screen.getByRole('combobox');
    await user.type(input, 'bl');
    await screen.findByRole('option', { name: 'Black' });

    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('Black');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('Escape closes the listbox without changing the typed value', async () => {
    stubFetch([{ id: '1', canonical_name: 'Black' }]);
    const user = userEvent.setup();
    const { onChange } = renderCombobox();
    onChange.mockClear();

    const input = screen.getByRole('combobox');
    await user.type(input, 'bl');
    await screen.findByRole('option', { name: 'Black' });

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalledWith('Black');
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
  it('maps each ranked item to a non-add-new option in order', () => {
    const ranked = [
      { id: '1', canonical_name: 'Black' },
      { id: '2', canonical_name: 'Blue' },
    ];
    const options = buildComboOptions(ranked, 'bl', true, 'Color');
    expect(options).toEqual([
      { key: '1', label: 'Black', value: 'Black', isAddNew: false },
      { key: '2', label: 'Blue', value: 'Blue', isAddNew: false },
    ]);
  });

  it('appends an "Add new color" option when there is no exact match and typed text is non-empty', () => {
    const options = buildComboOptions([], 'Lavender', false, 'Color');
    expect(options).toEqual([
      { key: '__add-new__', label: 'Add "Lavender" as a new Color', value: 'Lavender', isAddNew: true },
    ]);
  });

  it('omits the "Add new color" option when there is an exact match', () => {
    const ranked = [{ id: '1', canonical_name: 'Black' }];
    const options = buildComboOptions(ranked, 'Black', true, 'Color');
    expect(options).toEqual([{ key: '1', label: 'Black', value: 'Black', isAddNew: false }]);
  });

  it('omits the "Add new color" option when the typed value is empty', () => {
    expect(buildComboOptions([], '', false, 'Color')).toEqual([]);
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

describe('VocabCombobox mouse and blur interactions', () => {
  it('clicking an option selects it and closes the listbox', async () => {
    stubFetch([{ id: '1', canonical_name: 'Black' }]);
    const user = userEvent.setup();
    const { onChange } = renderCombobox();

    const input = screen.getByRole('combobox');
    await user.type(input, 'black');
    const option = await screen.findByRole('option', { name: 'Black' });

    await user.click(option);
    expect(onChange).toHaveBeenLastCalledWith('Black');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('hovering an option highlights it', async () => {
    stubFetch([
      { id: '1', canonical_name: 'Black' },
      { id: '2', canonical_name: 'Blue' },
    ]);
    const user = userEvent.setup();
    renderCombobox();

    const input = screen.getByRole('combobox');
    await user.type(input, 'bl');
    const options = await screen.findAllByRole('option');

    await user.hover(options[1]);
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
  });

  it('blurring the input commits the typed value and closes the listbox', async () => {
    stubFetch([{ id: '1', canonical_name: 'Black' }]);
    const user = userEvent.setup();
    const { onChange } = renderCombobox();

    const input = screen.getByRole('combobox');
    await user.type(input, 'black');
    await screen.findByRole('option', { name: 'Black' });

    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith('black');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('VocabCombobox required and length-hint rendering', () => {
  it('shows a required marker on the label when required is true', () => {
    stubFetch([]);
    renderCombobox('', { required: true });
    expect(screen.getByText('Color *')).toBeInTheDocument();
  });

  it('shows a length-hint message when the typed value exceeds maxLength', () => {
    stubFetch([]);
    renderCombobox('a'.repeat(5), { maxLength: 3 });
    expect(screen.getByText(/longer than the 3-character limit/)).toBeInTheDocument();
  });
});

describe('VocabCombobox network-error and Enter-without-highlight fallbacks', () => {
  it('falls back to an empty item list when the endpoint fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    const user = userEvent.setup();
    renderCombobox();

    const input = screen.getByRole('combobox');
    await user.type(input, 'anything');
    expect(screen.queryByRole('option', { name: 'anything' })).not.toBeInTheDocument();
  });

  it('Enter with nothing highlighted just closes the listbox', async () => {
    stubFetch([{ id: '1', canonical_name: 'Black' }]);
    const user = userEvent.setup();
    renderCombobox();

    const input = screen.getByRole('combobox');
    await user.type(input, 'black');
    await screen.findByRole('option', { name: 'Black' });

    await user.keyboard('{Enter}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('VocabCombobox parameterization', () => {
  it('uses the configured endpoint, responseKey, and label rather than hardcoded color values', async () => {
    stubFetch(
      [{ id: '1', canonical_name: 'Cotton' }],
      [],
      '/api/materials',
      'materials'
    );
    const user = userEvent.setup();
    renderCombobox('', {
      endpoint: '/api/materials',
      responseKey: 'materials',
      suggestionField: 'material',
      label: 'Material',
    });

    expect(screen.getByText('Material')).toBeInTheDocument();

    const input = screen.getByRole('combobox');
    await user.type(input, 'Linen');
    const option = await screen.findByRole('option', { name: 'Add "Linen" as a new Material' });
    expect(option).toBeInTheDocument();
    expect(screen.queryByText(/as a new Color/)).not.toBeInTheDocument();
  });
});
