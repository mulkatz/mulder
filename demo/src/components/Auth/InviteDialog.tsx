import type React from 'react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/primitives/Button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/primitives/Dialog';
import { Input } from '@/components/primitives/Input';
import { useCreateInvite } from '@/features/auth/useCreateInvite';
import type { UserRole } from '@/lib/api-types';

export function InviteDialog({ children }: { children?: React.ReactNode }) {
  const createInvite = useCreateInvite();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('member');

  useEffect(() => {
    function handleOpenInvite() {
      setOpen(true);
    }

    window.addEventListener('mulder:open-invite', handleOpenInvite);
    return () => window.removeEventListener('mulder:open-invite', handleOpenInvite);
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await createInvite.mutateAsync({ email, role });
      toast.success('Invitation sent.');
      setEmail('');
      setOpen(false);
    } catch {
      toast.error('Could not create invitation.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {children ? <DialogTrigger asChild>{children}</DialogTrigger> : null}
      <DialogContent aria-describedby={undefined}>
        <form className="space-y-5" onSubmit={handleSubmit}>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">Admin</p>
            <DialogTitle className="mt-2 font-serif text-3xl text-ink">Create an invitation.</DialogTitle>
            <p className="mt-2 text-sm text-ink-muted">
              Mulder sends the invite link server-side. Tokens are intentionally not exposed in the browser.
            </p>
          </div>
          <label className="block space-y-2 text-sm text-ink-muted">
            Email
            <Input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label className="block space-y-2 text-sm text-ink-muted">
            Role
            <select
              className="w-full rounded-md border border-thread bg-raised px-3 py-2 text-sm text-ink focus:border-amber focus:outline-none"
              value={role}
              onChange={(event) => setRole(event.target.value as UserRole)}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <Button disabled={createInvite.isPending} type="submit">
            {createInvite.isPending ? 'Creating...' : 'Create invitation'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
