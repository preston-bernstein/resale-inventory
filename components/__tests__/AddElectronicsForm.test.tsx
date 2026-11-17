// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddElectronicsForm, { assignOptionalNumber } from '@/components/AddElectronicsForm';
import {
  describeSubmissionErrors,
  expectNoItemsPost,
  fieldByLabel,
  fillAndSubmit,
  postedItem,
  stubItemFormFetch,
  type User,
} from './itemFormFixtures';
import { jsonResponse } from '@/tests/jsonResponse';

const pushMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function fillRequiredFields(user: User) {
  await user.selectOptions(fieldByLabel('Brand *'), 'Apple');
  await user.type(fieldByLabel('Model *'), 'MacBook Pro');
  await user.type(fieldByLabel('Acquisition Cost (USD) *'), '450.00');
  await user.type(fieldByLabel('Acquisition Date *'), '2026-01-15');
}

/** Renders the form, fills the required fields and clicks Add Electronics Item. */
function submitRequiredFields() {
  return fillAndSubmit(<AddElectronicsForm />, 'Add Electronics Item', fillRequiredFields);
}

describe('assignOptionalNumber', () => {
  it('assigns a parsed integer when the raw value is non-blank and parseable', () => {
    const body: Record<string, unknown> = {};
    assignOptionalNumber(body, 'ram_gb', '16', (s) => parseInt(s, 10));
    expect(body.ram_gb).toBe(16);
  });

  it('leaves the key unset when the raw value is blank', () => {
    const body: Record<string, unknown> = {};
    assignOptionalNumber(body, 'ram_gb', '  ', (s) => parseInt(s, 10));
    expect(body.ram_gb).toBeUndefined();
  });

  it('leaves the key unset when the parser produces NaN', () => {
    const body: Record<string, unknown> = {};
    assignOptionalNumber(body, 'ram_gb', 'not-a-number', (s) => parseInt(s, 10));
    expect(body.ram_gb).toBeUndefined();
  });

  it('supports a float parser for fields like screen_size_in', () => {
    const body: Record<string, unknown> = {};
    assignOptionalNumber(body, 'screen_size_in', '14.2', parseFloat);
    expect(body.screen_size_in).toBe(14.2);
  });
});

describe('AddElectronicsForm — rendering and minimal submit', () => {
  it('renders all fields with Condition defaulting to Good', () => {
    render(<AddElectronicsForm />);

    expect(fieldByLabel('Brand *')).toBeInTheDocument();
    expect(fieldByLabel('Model *')).toBeInTheDocument();
    expect(fieldByLabel('Processor')).toBeInTheDocument();
    expect(fieldByLabel('RAM (GB)')).toBeInTheDocument();
    expect(fieldByLabel('Storage (GB)')).toBeInTheDocument();
    expect(fieldByLabel('Screen Size (in)')).toBeInTheDocument();
    expect(fieldByLabel('Battery Health (%)')).toBeInTheDocument();
    expect(fieldByLabel('Battery Cycle Count')).toBeInTheDocument();
    expect(fieldByLabel('Acquisition Cost (USD) *')).toBeInTheDocument();
    expect(fieldByLabel('Acquisition Date *')).toBeInTheDocument();

    const condition = fieldByLabel('Condition *') as HTMLSelectElement;
    expect(condition.value).toBe('Good');

    expect(screen.getByRole('button', { name: 'Add Electronics Item' })).toBeInTheDocument();
  });

  it('submits a valid minimal form (required fields only) with the right payload and redirects on success', async () => {
    const fetchMock = stubItemFormFetch({ items: () => jsonResponse({}, true, 201) });
    await submitRequiredFields();

    expect(pushMock).toHaveBeenCalledWith('/inventory');

    const { init, body } = postedItem(fetchMock);
    expect(init.method).toBe('POST');
    expect(body).toEqual({
      category: 'electronics',
      device_type: 'laptop',
      title: 'Apple MacBook Pro',
      brand: 'Apple',
      model: 'MacBook Pro',
      condition: 'Good',
      acquisition_cost: 45000,
      acquisition_date: '2026-01-15',
    });
  });
});

describe('AddElectronicsForm — optional fields', () => {
  it('includes trimmed processor and parsed optional numeric fields when provided', async () => {
    const fetchMock = stubItemFormFetch({ items: () => jsonResponse({}, true, 201) });
    const user = userEvent.setup();
    render(<AddElectronicsForm />);

    await fillRequiredFields(user);
    await user.type(fieldByLabel('Processor'), '  M2 Pro  ');
    await user.type(fieldByLabel('RAM (GB)'), '16');
    await user.type(fieldByLabel('Storage (GB)'), '512');
    await user.type(fieldByLabel('Screen Size (in)'), '14.2');
    await user.type(fieldByLabel('Battery Health (%)'), '92');
    await user.type(fieldByLabel('Battery Cycle Count'), '50');
    await user.click(screen.getByRole('button', { name: 'Add Electronics Item' }));

    const { body } = postedItem(fetchMock);
    expect(body.processor).toBe('M2 Pro');
    expect(body.ram_gb).toBe(16);
    expect(body.storage_gb).toBe(512);
    expect(body.screen_size_in).toBe(14.2);
    expect(body.battery_health_pct).toBe(92);
    expect(body.battery_cycle_count).toBe(50);
  });

  it('omits optional fields entirely from the payload when left blank', async () => {
    const fetchMock = stubItemFormFetch({ items: () => jsonResponse({}, true, 201) });
    await submitRequiredFields();

    const { body } = postedItem(fetchMock);
    expect(body).not.toHaveProperty('processor');
    expect(body).not.toHaveProperty('ram_gb');
    expect(body).not.toHaveProperty('storage_gb');
    expect(body).not.toHaveProperty('screen_size_in');
    expect(body).not.toHaveProperty('battery_health_pct');
    expect(body).not.toHaveProperty('battery_cycle_count');
  });
});

describe('AddElectronicsForm — validation', () => {
  it('blocks submission via native required validation when Model is missing', async () => {
    const fetchMock = stubItemFormFetch({ items: () => jsonResponse({}, true, 201) });
    const user = userEvent.setup();
    render(<AddElectronicsForm />);

    await user.selectOptions(fieldByLabel('Brand *'), 'Apple');
    await user.type(fieldByLabel('Acquisition Cost (USD) *'), '450.00');
    await user.type(fieldByLabel('Acquisition Date *'), '2026-01-15');

    await user.click(screen.getByRole('button', { name: 'Add Electronics Item' }));

    expectNoItemsPost(fetchMock);
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describeSubmissionErrors({
  name: 'AddElectronicsForm',
  submit: submitRequiredFields,
  pushMock,
  fieldError: { field: 'model', message: 'Model already exists.' },
});
