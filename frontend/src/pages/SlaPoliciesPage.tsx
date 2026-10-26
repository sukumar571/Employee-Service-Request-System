import {
  updateSlaPolicyBodySchema,
  type RequestPriority,
  type SlaPolicyDto,
  type UpdateSlaPolicyBody,
} from '@esrs/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { PriorityBadge } from '../components/Badge';
import { ErrorNotice, Notice, Spinner } from '../components/Feedback';
import { useSlaPolicies, useUpdateSlaPolicy } from '../api/queries';
import { formatBusinessMinutes, formatInstant, humanize } from '../lib/format';

/**
 * SLA policy editor (FR-15 / ST-403). The form is validated client-side with the *same* Zod schema
 * the API parses, and a rejected submission renders the server envelope verbatim — including the
 * `UNAUTHENTICATED` code you get before Phase 5 lands, which is the point of this screen: it shows
 * authorization is enforced at the API, not hidden by the UI.
 */
function PolicyForm({ policy, onDone }: { policy: SlaPolicyDto; onDone: () => void }) {
  const mutation = useUpdateSlaPolicy();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<UpdateSlaPolicyBody>({
    resolver: zodResolver(updateSlaPolicyBodySchema),
    defaultValues: {
      first_response_minutes: policy.first_response_minutes,
      resolution_minutes: policy.resolution_minutes,
      reason: '',
    },
  });

  // Re-seed the form when a save succeeds and the query refetches new server values.
  useEffect(() => {
    reset({
      first_response_minutes: policy.first_response_minutes,
      resolution_minutes: policy.resolution_minutes,
      reason: '',
    });
  }, [policy.first_response_minutes, policy.resolution_minutes, reset]);

  const submit = handleSubmit((values) => {
    mutation.mutate({ priority: policy.priority, body: values }, { onSuccess: onDone });
  });

  return (
    <form className="space-y-3" onSubmit={(event) => void submit(event)}>
      <h3 className="text-sm font-semibold">Edit the “{humanize(policy.priority)}” policy</h3>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="first_response_minutes">
            First response (business minutes)
          </label>
          <input
            id="first_response_minutes"
            className="field"
            type="number"
            min={5}
            max={10080}
            step={5}
            {...register('first_response_minutes', { valueAsNumber: true })}
          />
          {errors.first_response_minutes ? (
            <p className="mt-1 text-xs text-sla-breached">
              {errors.first_response_minutes.message}
            </p>
          ) : null}
        </div>

        <div>
          <label className="label" htmlFor="resolution_minutes">
            Resolution (business minutes)
          </label>
          <input
            id="resolution_minutes"
            className="field"
            type="number"
            min={15}
            max={43200}
            step={15}
            {...register('resolution_minutes', { valueAsNumber: true })}
          />
          {errors.resolution_minutes ? (
            <p className="mt-1 text-xs text-sla-breached">{errors.resolution_minutes.message}</p>
          ) : null}
        </div>
      </div>

      <div>
        <label className="label" htmlFor="reason">
          Change reason (audited, min. 10 characters)
        </label>
        <textarea id="reason" className="field" rows={2} {...register('reason')} />
        {errors.reason ? (
          <p className="mt-1 text-xs text-sla-breached">{errors.reason.message}</p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={isSubmitting || mutation.isPending}
        >
          {mutation.isPending ? 'Saving…' : 'Save policy'}
        </button>
        <button
          type="button"
          className="btn border border-border bg-white text-ink"
          onClick={onDone}
        >
          Cancel
        </button>
      </div>

      {mutation.isError ? (
        <ErrorNotice error={mutation.error} heading="The API rejected this change" />
      ) : null}
      {mutation.isSuccess ? (
        <Notice tone="success">Policy updated and written to the audit trail.</Notice>
      ) : null}
    </form>
  );
}

export function SlaPoliciesPage() {
  const policies = useSlaPolicies();
  const [editing, setEditing] = useState<RequestPriority | null>(null);
  const editingPolicy = policies.data?.find((policy) => policy.priority === editing);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">SLA policies</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Targets are expressed in business time, evaluated against the window advertised by{' '}
          <code className="font-mono text-xs">GET /meta</code>. Only managers and administrators may
          change them.
        </p>
      </header>

      {policies.isPending ? <Spinner label="Loading policies" /> : null}
      {policies.error ? (
        <ErrorNotice error={policies.error} heading="Policies unavailable" />
      ) : null}

      {policies.data ? (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[42rem] text-left text-sm">
            <caption className="sr-only">SLA targets per priority</caption>
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-3 py-2">Priority</th>
                <th className="px-3 py-2">First response</th>
                <th className="px-3 py-2">Resolution</th>
                <th className="px-3 py-2">Business window</th>
                <th className="px-3 py-2">Last change</th>
                <th className="px-3 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {policies.data.map((policy) => (
                <tr key={policy.priority} className="border-t border-border/60">
                  <td className="px-3 py-2">
                    <PriorityBadge priority={policy.priority} />
                  </td>
                  <td className="px-3 py-2">
                    {formatBusinessMinutes(policy.first_response_minutes)}
                  </td>
                  <td className="px-3 py-2">{formatBusinessMinutes(policy.resolution_minutes)}</td>
                  <td className="px-3 py-2 text-xs">
                    {policy.business_hours.start}–{policy.business_hours.end}{' '}
                    {policy.business_hours.timezone}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {policy.updated_at ? formatInstant(policy.updated_at) : 'seed default'}
                    {policy.updated_by ? ` · ${policy.updated_by}` : ''}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      className="btn border border-border bg-white text-ink"
                      onClick={() =>
                        setEditing(editing === policy.priority ? null : policy.priority)
                      }
                      aria-expanded={editing === policy.priority}
                    >
                      {editing === policy.priority ? 'Close' : 'Edit'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {editingPolicy ? (
        <section className="card p-4">
          <PolicyForm
            key={editingPolicy.priority}
            policy={editingPolicy}
            onDone={() => setEditing(null)}
          />
        </section>
      ) : null}

      <Notice tone="info" title="Server-side rules still apply">
        <ul className="list-disc pl-5">
          <li>Resolution target must be longer than the first-response target.</li>
          <li>
            Every change needs a reason of at least 10 characters and is recorded in the audit log.
          </li>
          <li>Requests warn at 75 % of elapsed business time before they breach.</li>
        </ul>
      </Notice>
    </div>
  );
}
