import { AuthForm } from '../src/components/AuthForm';

/** Login (DESIGN.md §6.1) — reached from the header avatar when signed out. */
export default function LoginScreen() {
  return <AuthForm mode="login" />;
}
