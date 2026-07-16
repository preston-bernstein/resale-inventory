interface CredentialFieldsProps {
  email: string;
  onEmailChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  passwordAutoComplete: 'current-password' | 'new-password';
}

/** Email + password input pair shared by the login and signup pages. */
export function CredentialFields({
  email,
  onEmailChange,
  password,
  onPasswordChange,
  passwordAutoComplete,
}: CredentialFieldsProps) {
  return (
    <>
      <div>
        <label htmlFor="email">Email</label>
        <br />
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="password">Password</label>
        <br />
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={passwordAutoComplete}
          required
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
        />
      </div>
    </>
  );
}
