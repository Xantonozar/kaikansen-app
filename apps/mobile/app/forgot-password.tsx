import { ForgotPasswordForm } from '../src/components/ForgotPasswordForm';

/**
 * Forgot / Reset password — reached from Login's "Forgot password?"
 * link (the position the Login mock draws). One route, two steps:
 * request a code, then enter it with a new password.
 */
export default function ForgotPasswordScreen() {
  return <ForgotPasswordForm />;
}
