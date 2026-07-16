import { describe, it, expect } from 'vitest';
import { loginErrorMessage, signupErrorMessage } from '../authErrorMessages';

describe('loginErrorMessage', () => {
  it('returns the server error message when present', () => {
    expect(loginErrorMessage(401, { error: 'Invalid email or password.' })).toBe('Invalid email or password.');
  });

  it('falls back to a generic message when the server sends none', () => {
    expect(loginErrorMessage(500, {})).toBe('Login failed.');
  });
});

describe('signupErrorMessage', () => {
  it('reports a duplicate-email 409 using the server message', () => {
    expect(signupErrorMessage(409, { error: 'Email already registered.' })).toBe('Email already registered.');
  });

  it('falls back to a generic duplicate-email message when the server sends none', () => {
    expect(signupErrorMessage(409, {})).toBe('Email already registered.');
  });

  it('joins field names for a 422 validation failure', () => {
    expect(signupErrorMessage(422, { fields: ['email', 'password'] })).toBe('Validation failed: email, password.');
  });

  it('falls back to the server error message for a 422 with no fields array', () => {
    expect(signupErrorMessage(422, { error: 'Weak password.' })).toBe('Weak password.');
  });

  it('falls back to a generic validation message for a 422 with neither fields nor error', () => {
    expect(signupErrorMessage(422, {})).toBe('Validation failed.');
  });

  it('falls back to a generic signup-failed message for any other status', () => {
    expect(signupErrorMessage(500, {})).toBe('Signup failed.');
  });

  it('uses the server error message for any other status when present', () => {
    expect(signupErrorMessage(503, { error: 'Service unavailable.' })).toBe('Service unavailable.');
  });
});
