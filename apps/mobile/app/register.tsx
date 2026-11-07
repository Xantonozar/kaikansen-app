import { AuthForm } from '../src/components/AuthForm';

/** Register (DESIGN.md §6.2) — linked from Login, and vice versa. */
export default function RegisterScreen() {
  return <AuthForm mode="register" />;
}
