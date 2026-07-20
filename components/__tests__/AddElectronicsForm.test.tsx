// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddElectronicsForm, { assignOptionalNumber } from '@/components/AddElectronicsForm';

const pushMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/**
 * This app's field labels are bare <label> elements with no for/id
 * association to their input — walk from the label text to the nearest
 * sibling input/select/textarea instead of relying on getByLabelText.
 */
function fieldByLabel(labelText: string): HTMLElement {
  const labels = Array.from(document.querySelectorAll('label'));
  const label = labels.find(l => l.textContent?.trim().startsWith(labelText));
  if (!label) throw new Error(`No label found starting with "${labelText}"`);
  const el = label.parentElement?.querySelector('input, select, textarea');
  if (!el) throw new Error(`No form control found for label "${labelText}"`);
  return el as HTMLElement;
}

function stubFetch(itemsResponse: Response) {
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/items') return itemsResponse;
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(fieldByLabel('Brand *'), 'Apple');
  await user.type(fieldByLabel('Model *'), 'MacBook Pro');
  await user.type(fieldByLabel('Acquisition Cost (USD) *'), '450.00');
  await user.type(fieldByLabel('Acquisition Date *'), '2026-01-15');
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

describe('AddElectronicsForm', () => {
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
    const fetchMock = stubFetch({ ok: true, status: 201, json: async () => ({}) } as Response);
    const user = userEvent.setup();
    render(<AddElectronicsForm />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: 'Add Electronics Item' }));

    expect(pushMock).toHaveBeenCalledWith('/inventory');

    const postCall = fetchMock.mock.calls.find(c => String(c[0]) === '/api/items');
    expect(postCall).toBeTruthy();
    const init = postCall![1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
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

  it('includes trimmed processor and parsed optional numeric fields when provided', async () => {
    const fetchMock = stubFetch({ ok: true, status: 201, json: async () => ({}) } as Response);
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

    const postCall = fetchMock.mock.calls.find(c => String(c[0]) === '/api/items');
    const body = JSON.parse((postCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.processor).toBe('M2 Pro');
    expect(body.ram_gb).toBe(16);
    expect(body.storage_gb).toBe(512);
    expect(body.screen_size_in).toBe(14.2);
    expect(body.battery_health_pct).toBe(92);
    expect(body.battery_cycle_count).toBe(50);
  });

  it('omits optional fields entirely from the payload when left blank', async () => {
    const fetchMock = stubFetch({ ok: true, status: 201, json: async () => ({}) } as Response);
    const user = userEvent.setup();
    render(<AddElectronicsForm />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: 'Add Electronics Item' }));

    const postCall = fetchMock.mock.calls.find(c => String(c[0]) === '/api/items');
    const body = JSON.parse((postCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('processor');
    expect(body).not.toHaveProperty('ram_gb');
    expect(body).not.toHaveProperty('storage_gb');
    expect(body).not.toHaveProperty('screen_size_in');
    expect(body).not.toHaveProperty('battery_health_pct');
    expect(body).not.toHaveProperty('battery_cycle_count');
  });

  it('blocks submission via native required validation when Model is missing', async () => {
    const fetchMock = stubFetch({ ok: true, status: 201, json: async () => ({}) } as Response);
    const user = userEvent.setup();
    render(<AddElectronicsForm />);

    await user.selectOptions(fieldByLabel('Brand *'), 'Apple');
    await user.type(fieldByLabel('Acquisition Cost (USD) *'), '450.00');
    await user.type(fieldByLabel('Acquisition Date *'), '2026-01-15');

    await user.click(screen.getByRole('button', { name: 'Add Electronics Item' }));

    expect(fetchMock.mock.calls.some(c => String(c[0]) === '/api/items')).toBe(false);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('surfaces field-level errors from a 422 response without redirecting', async () => {
    stubFetch({
      ok: false,
      status: 422,
      json: async () => ({ fields: { model: 'Model already exists.' } }),
    } as Response);
    const user = userEvent.setup();
    render(<AddElectronicsForm />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: 'Add Electronics Item' }));

    expect(await screen.findByText('Model already exists.')).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('surfaces a generic submission error when the server returns a non-201/422 status with an error message', async () => {
    stubFetch({ ok: false, status: 500, json: async () => ({ error: 'Database is on fire.' }) } as Response);
    const user = userEvent.setup();
    render(<AddElectronicsForm />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: 'Add Electronics Item' }));

    expect(await screen.findByText('Database is on fire.')).toBeInTheDocument();
  });
});
