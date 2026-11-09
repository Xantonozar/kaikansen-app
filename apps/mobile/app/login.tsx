import { AuthForm } from '../src/components/AuthForm';

/** Login (DESIGN.md §6.1) — reached from the drawer's Log in item. */
export default function LoginScreen() {
  return <AuthForm mode="login" />;
}
