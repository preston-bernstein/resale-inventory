interface AuthErrorData {
  error?: string;
  fields?: string[];
}

export function loginErrorMessage(_status: number, data: AuthErrorData): string {
  return data.error ?? 'Login failed.';
}

export function signupErrorMessage(status: number, data: AuthErrorData): string {
  if (status === 409) return data.error ?? 'Email already registered.';
  if (status === 422) {
    const fields = Array.isArray(data.fields) ? data.fields.join(', ') : '';
    return fields ? `Validation failed: ${fields}.` : (data.error ?? 'Validation failed.');
  }
  return data.error ?? 'Signup failed.';
}
