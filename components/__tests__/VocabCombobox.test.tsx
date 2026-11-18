// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VocabCombobox } from '../VocabCombobox';
import { describeKeyboardContract } from './comboboxKeyboardContract';

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

describeKeyboardContract({
  name: 'VocabCombobox',
  stubItems: (names) => stubFetch(names.map((canonical_name, i) => ({ id: String(i + 1), canonical_name }))),
  renderCombobox: () => renderCombobox(),
  first: 'Black',
  second: 'Blue',
  prefix: 'bl',
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
