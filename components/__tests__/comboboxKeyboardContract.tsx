import { describe, it, expect, type Mock } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Keyboard behavior shared by BrandCombobox and VocabCombobox: both are
 * hand-rolled ARIA comboboxes with the same open, move, select and escape
 * rules. Each component's test file runs this contract with its own sample
 * names.
 */
export interface KeyboardContract {
  /** Component name, used in the describe titles. */
  name: string;
  /** Stubs the combobox's fetches so these names are its canonical items. */
  stubItems: (names: string[]) => void;
  renderCombobox: () => { onChange: Mock };
  /** Two canonical names that both match `prefix`; `first` sorts first. */
  first: string;
  second: string;
  prefix: string;
}

async function typeAndWaitFor(prefix: string, optionName: string) {
  const user = userEvent.setup();
  await user.type(screen.getByRole('combobox'), prefix);
  await screen.findByRole('option', { name: optionName });
  return user;
}

function describeOpenAndMove({ name, stubItems, renderCombobox, first, second, prefix }: KeyboardContract) {
  describe(`${name} keyboard interactions — open and move`, () => {
    it('ArrowDown opens the listbox and highlights the first option', async () => {
      stubItems([first, second]);
      renderCombobox();
      const user = await typeAndWaitFor(prefix, first);

      await user.keyboard('{ArrowDown}');
      const firstOption = screen.getAllByRole('option')[0];
      expect(firstOption).toHaveAttribute('aria-selected', 'true');
    });

    it('ArrowDown then ArrowUp returns the highlight to the previous option', async () => {
      stubItems([first, second]);
      renderCombobox();
      const user = await typeAndWaitFor(prefix, first);

      await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}');
      const options = screen.getAllByRole('option');
      expect(options[0]).toHaveAttribute('aria-selected', 'true');
      expect(options[1]).toHaveAttribute('aria-selected', 'false');
    });
  });
}

function describeBoundsAndSelect({ name, stubItems, renderCombobox, first, prefix }: KeyboardContract) {
  describe(`${name} keyboard interactions — bounds and select`, () => {
    it('ArrowDown past the last option stays on the last option (no wraparound)', async () => {
      stubItems([first]);
      renderCombobox();
      // Typing the full name leaves the canonical item as the only option
      // (an exact match offers no "Add new" entry).
      const user = await typeAndWaitFor(first.toLowerCase(), first);

      await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
      expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true');
    });

    it('Enter with an option highlighted selects it and closes the listbox', async () => {
      stubItems([first]);
      const { onChange } = renderCombobox();
      const user = await typeAndWaitFor(prefix, first);

      await user.keyboard('{ArrowDown}{Enter}');
      expect(onChange).toHaveBeenLastCalledWith(first);
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });
}

function describeEscape({ name, stubItems, renderCombobox, first, prefix }: KeyboardContract) {
  describe(`${name} keyboard interactions — escape`, () => {
    it('Escape closes the listbox without changing the typed value', async () => {
      stubItems([first]);
      const { onChange } = renderCombobox();
      onChange.mockClear();
      const user = await typeAndWaitFor(prefix, first);

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalledWith(first);
    });

    it('Escape with the listbox already closed is a no-op', async () => {
      stubItems([]);
      const user = userEvent.setup();
      renderCombobox();

      screen.getByRole('combobox').blur();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });
}

export function describeKeyboardContract(contract: KeyboardContract) {
  describeOpenAndMove(contract);
  describeBoundsAndSelect(contract);
  describeEscape(contract);
}
