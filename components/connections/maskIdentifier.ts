// Masks a marketplace account identifier (e.g. a username/handle) for
// display in the UI, so a connected account's raw identifier is never
// rendered to the screen.
//
// Rule (deliberately simple and length-leak-resistant):
//   - length <= 2: identifier is fully masked with a fixed-width mask
//     ('***'). Showing any real character from a 1-2 char identifier would
//     expose the entire (or nearly the entire) raw value, so nothing real
//     is shown at all.
//   - length >= 3: first char + a FIXED 3-asterisk middle + last char.
//     The middle is always exactly 3 asterisks regardless of the actual
//     identifier length, so the mask's width never reveals how long the
//     real identifier is (a 5-char and a 50-char identifier both render
//     as a 5-character mask, e.g. 'h***o').
export function maskIdentifier(identifier: string): string {
  if (identifier.length <= 2) {
    return '***';
  }

  const first = identifier.charAt(0);
  const last = identifier.charAt(identifier.length - 1);
  return `${first}***${last}`;
}
