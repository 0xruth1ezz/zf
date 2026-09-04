import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Database, KeyRound, LoaderCircle, Plus, Save, Trash2 } from 'lucide-react';
import { AccountBadge } from '../components/account-badge';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogTrigger } from '../components/ui/dialog';
import { Field } from '../components/ui/field';
import { Switch } from '../components/ui/switch';
import { PageHeader } from '../components/page-header';
import { deleteAccount, formatDateTime, isSnapshotMode, saveAccount } from '../data';

function formValues(form) {
  const data = new FormData(form);
  return {
    id: String(data.get('id') || ''),
    phone: String(data.get('phone') || ''),
    password: String(data.get('password') || ''),
    ...(data.get('enabled') ? { enabled: '1' } : {}),
  };
}

function DeleteAccountDialog({ accountId, isDisabled, onDeleted }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => deleteAccount(accountId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onDeleted(`Deleted “${accountId}”.`);
    },
  });

  return (
    <DialogTrigger>
      <Button aria-label={`Delete ${accountId}`} isDisabled={isDisabled} size="sm" type="button" variant="destructive">
        <Trash2 aria-hidden="true" />
        Delete
      </Button>
      <Dialog
        description={`This removes “${accountId}” from the local credential store. Existing activity records are kept.`}
        title="Delete account?"
      >
        {({ close }) => (
          <>
            {mutation.error ? <p role="alert" className="rounded-md bg-destructive/8 px-3 py-2 text-sm text-destructive">{mutation.error.message}</p> : null}
            <div className="flex justify-end gap-2">
              <Button onPress={close} variant="outline">Cancel</Button>
              <Button
                isDisabled={mutation.isPending}
                onPress={() => mutation.mutate(undefined, { onSuccess: close })}
                variant="destructive"
              >
                {mutation.isPending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Trash2 aria-hidden="true" />}
                {mutation.isPending ? 'Deleting' : 'Delete account'}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </DialogTrigger>
  );
}

function AccountRow({ account, readOnly, onNotice }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: saveAccount,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onNotice(`Saved “${account.id}”.`);
    },
  });

  function handleSubmit(event) {
    event.preventDefault();
    mutation.mutate(formValues(event.currentTarget));
  }

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/45 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-background text-muted-foreground">
            <KeyRound aria-hidden="true" className="size-4" />
          </div>
          <div className="min-w-0">
            <h2 className="flex min-w-0"><AccountBadge accountId={account.id} className="max-w-full" /></h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Updated {formatDateTime(account.updatedAt)}</p>
          </div>
        </div>
        <Badge variant={account.enabled ? 'success' : 'neutral'}>{account.enabled ? 'Enabled' : 'Paused'}</Badge>
      </div>
      <form className="grid gap-4 p-4" onSubmit={handleSubmit}>
        <input name="id" type="hidden" value={account.id} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field defaultValue={account.phone} isDisabled={readOnly} isRequired label="Phone" name="phone" type="tel" />
          <Field isDisabled={readOnly} label="Password" name="password" placeholder="Leave blank to keep" type="password" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <Switch defaultSelected={account.enabled} isDisabled={readOnly} name="enabled" value="1">Crawler enabled</Switch>
          <div className="flex gap-2">
            <DeleteAccountDialog accountId={account.id} isDisabled={readOnly} onDeleted={onNotice} />
            <Button isDisabled={readOnly || mutation.isPending} size="sm" type="submit">
              {mutation.isPending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Save aria-hidden="true" />}
              {mutation.isPending ? 'Saving' : 'Save'}
            </Button>
          </div>
        </div>
        {mutation.error ? <p role="alert" className="text-sm font-medium text-destructive">{mutation.error.message}</p> : null}
      </form>
    </article>
  );
}

function AddAccountForm({ readOnly, onNotice }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: saveAccount,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onNotice('Account added.');
    },
  });

  function handleSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    mutation.mutate(formValues(form), {
      onSuccess: () => form.reset(),
    });
  }

  return (
    <aside className="h-fit rounded-lg border border-border bg-card p-4 lg:sticky lg:top-24">
      <div className="mb-4 flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <Plus aria-hidden="true" className="size-4" />
        </div>
        <div>
          <h2 className="text-sm font-semibold">Add account</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Credentials are stored in the crawler’s local SQLite database.</p>
        </div>
      </div>
      <form className="grid gap-3" onSubmit={handleSubmit}>
        <Field isDisabled={readOnly} isRequired label="Account ID" name="id" placeholder="primary" />
        <Field inputMode="numeric" isDisabled={readOnly} isRequired label="Phone" name="phone" type="tel" />
        <Field autoComplete="new-password" isDisabled={readOnly} isRequired label="Password" name="password" type="password" />
        <Switch defaultSelected isDisabled={readOnly} name="enabled" value="1">Crawler enabled</Switch>
        <Button className="mt-1 w-full" isDisabled={readOnly || mutation.isPending} type="submit">
          {mutation.isPending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Plus aria-hidden="true" />}
          {mutation.isPending ? 'Adding account' : 'Add account'}
        </Button>
        {mutation.error ? <p role="alert" className="text-sm font-medium text-destructive">{mutation.error.message}</p> : null}
      </form>
    </aside>
  );
}

export function AccountsPage({ data }) {
  const [notice, setNotice] = useState('');
  const readOnly = isSnapshotMode();

  return (
    <>
      <PageHeader
        description="Maintain the credentials and crawler state used for daily sign-ins and lottery engagement."
        title="Accounts"
      />
      {readOnly ? (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-info/25 bg-info/8 px-4 py-3 text-sm text-info">
          <Database aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p><strong className="font-semibold">Read-only snapshot.</strong> Open the report server to add, edit, or remove accounts.</p>
        </div>
      ) : null}
      <div aria-live="polite" className="sr-only">{notice}</div>
      {notice ? (
        <div className="mb-5 rounded-md border border-success/25 bg-success/8 px-3 py-2 text-sm font-medium text-success" role="status">
          {notice}
        </div>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-labelledby="saved-accounts-title">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold" id="saved-accounts-title">Saved accounts</h2>
              <p className="mt-1 text-xs text-muted-foreground">Enabled database accounts take priority over environment fallback credentials.</p>
            </div>
            <Badge>{data.accounts.length}</Badge>
          </div>
          {data.accounts.length ? (
            <div className="grid gap-3">
              {data.accounts.map((account) => (
                <AccountRow key={`${account.id}:${account.updatedAt}`} account={account} onNotice={setNotice} readOnly={readOnly} />
              ))}
            </div>
          ) : (
            <div className="grid min-h-48 place-items-center rounded-lg border border-dashed border-border bg-muted/25 px-6 py-10 text-center">
              <div className="max-w-sm">
                <Database aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
                <h3 className="mt-3 text-sm font-semibold">No database accounts</h3>
                <p className="mt-1.5 text-sm leading-6 text-muted-foreground">Add an account to manage credentials here. Until then, the crawler uses environment fallback credentials.</p>
              </div>
            </div>
          )}
        </section>
        <AddAccountForm onNotice={setNotice} readOnly={readOnly} />
      </div>
    </>
  );
}
