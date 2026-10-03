import { useState, type FormEvent } from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Field } from '../components/ui/field';
import { login } from '../data';

function destination() {
  const next = new URLSearchParams(window.location.search).get('next') || '/';
  try {
    const url = new URL(next, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname === '/login') return '/';
    // Preserve a hash route carried through the server's login redirect.
    return url.pathname + url.search + (url.hash || window.location.hash);
  } catch {
    return '/';
  }
}

export function LoginPage() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const values = {
      username: String(form.get('username') || ''),
      password: String(form.get('password') || ''),
    };
    setPending(true);
    setError('');
    try {
      await login(values);
      window.location.replace(destination());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to sign in. Please try again.');
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-svh place-items-center bg-sidebar px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <div aria-hidden="true" className="grid size-10 shrink-0 place-items-center bg-primary text-sm font-extrabold tracking-tight text-primary-foreground shadow-sm">ZF</div>
          <div>
            <p className="text-sm font-semibold">zFrontier</p>
            <p className="text-xs text-muted-foreground">Crawler operations</p>
          </div>
        </div>

        <section aria-labelledby="login-heading" className="border border-border bg-card p-6 sm:p-8">
          <h1 id="login-heading" className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Access your crawler workspace.</p>

          <form className="mt-7 grid gap-5" onSubmit={handleSubmit} aria-busy={pending}>
            <Field autoFocus autoComplete="username" isRequired isReadOnly={pending} label="Username" name="username" inputClassName="h-11 border-border shadow-none" />
            <Field autoComplete="current-password" isRequired isReadOnly={pending} label="Password" name="password" type="password" inputClassName="h-11 border-border shadow-none" />
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <Button className="mt-1 h-11 w-full" isDisabled={pending} type="submit">
              {pending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
              {pending ? 'Signing in…' : 'Sign in'}
              {!pending ? <ArrowRight aria-hidden="true" className="ml-auto" /> : null}
            </Button>
          </form>
        </section>

        <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">You’ll stay signed in on this browser.</p>
      </div>
    </main>
  );
}
