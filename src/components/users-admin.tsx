"use client";
// Admin: user accounts (create, role, groups, disable, reset password) and group access
// (which knowledge collections each group may search).
import { useCallback, useEffect, useState } from "react";

interface Group { id: string; name: string; members: number; collectionIds: string[] }
interface User { id: string; email: string; name: string; role: "ADMIN" | "MEMBER"; disabled: boolean; mustChangePassword: boolean; groups: { id: string; name: string }[] }
interface Collection { id: string; name: string }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, { ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  } catch {
    throw new Error("Can't reach the server. Check your connection.");
  }
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message?: string; details?: { message: string }[] } };
  if (!r.ok) throw new Error(j.error?.details?.[0]?.message ?? j.error?.message ?? `Request failed (${r.status}).`);
  return j;
}

export function UsersAdmin({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    try {
      const [u, g, c] = await Promise.all([
        api<{ users: User[] }>("/api/admin/users"),
        api<{ groups: Group[] }>("/api/admin/groups"),
        api<{ collections: Collection[] }>("/api/collections"),
      ]);
      setUsers(u.users);
      setGroups(g.groups);
      setCollections(c.collections);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run an action, show its outcome, and refresh. */
  async function run(action: () => Promise<unknown>, done?: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  const shown = users.filter((u) => !filter || `${u.name} ${u.email}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-6">
      <div>
        <p className="eyebrow mb-2">Administration</p>
        <h1 className="font-display text-2xl font-semibold text-white">Users &amp; access</h1>
        <p className="mt-1 text-sm text-faint">People sign in with a temporary password you give them, then choose their own. What they can ask about is decided by their groups.</p>
      </div>

      {error && <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-200">{error}</div>}
      {notice && <div role="status" className="rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-4 py-2.5 text-sm text-emerald-200">{notice}</div>}
      {secret && <TempPassword {...secret} onClose={() => setSecret(null)} />}

      <CreateUser
        groups={groups}
        onCreate={(input) =>
          run(async () => {
            const r = await api<{ email: string; tempPassword: string }>("/api/admin/users", { method: "POST", body: JSON.stringify(input) });
            setSecret({ email: r.email, password: r.tempPassword });
          })
        }
      />

      <section className="glass overflow-x-auto rounded-2xl">
        <div className="flex flex-wrap items-center gap-3 border-b hairline p-4">
          <h2 className="font-display flex-1 text-lg font-semibold text-white">People <span className="text-sm font-normal text-faint">({users.length})</span></h2>
          <input className="input !w-56" placeholder="Search name or email" aria-label="Search users" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <table className="w-full text-sm">
          <thead className="bg-white/[0.03] text-left text-[11px] uppercase tracking-wider text-faint">
            <tr><th className="p-3">Person</th><th className="p-3">Role</th><th className="p-3">Groups</th><th className="p-3">Status</th><th className="p-3"><span className="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            {shown.map((u) => (
              <UserRow
                key={u.id}
                u={u}
                self={u.id === currentUserId}
                groups={groups}
                editing={editing === u.id}
                onEdit={() => setEditing(editing === u.id ? null : u.id)}
                onSave={async (patch) => {
                  if (await run(() => api(`/api/admin/users/${u.id}`, { method: "PATCH", body: JSON.stringify(patch) }), `Saved changes for ${u.name}.`)) setEditing(null);
                }}
                onToggleDisabled={() => {
                  if (!u.disabled && !confirm(`Disable ${u.name}? They are signed out immediately and can't sign in until re-enabled.`)) return;
                  void run(() => api(`/api/admin/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ disabled: !u.disabled }) }), u.disabled ? `${u.name} can sign in again.` : `${u.name} is disabled.`);
                }}
                onReset={() => {
                  if (!confirm(`Reset ${u.name}'s password? They are signed out and must use the new temporary password.`)) return;
                  void run(async () => {
                    const r = await api<{ tempPassword: string }>(`/api/admin/users/${u.id}/reset-password`, { method: "POST" });
                    setSecret({ email: u.email, password: r.tempPassword });
                  });
                }}
              />
            ))}
            {!shown.length && <tr><td colSpan={5} className="p-6 text-center text-faint">{loading ? "Loading…" : filter ? "No one matches that search." : "No users yet."}</td></tr>}
          </tbody>
        </table>
      </section>

      <GroupsPanel
        groups={groups}
        collections={collections}
        onCreate={(name) => run(() => api("/api/admin/groups", { method: "POST", body: JSON.stringify({ name, collectionIds: [] }) }), `Group "${name}" created. Choose what it can search below.`)}
        onToggle={(g, collectionId) => {
          const has = g.collectionIds.includes(collectionId);
          const collectionIds = has ? g.collectionIds.filter((x) => x !== collectionId) : [...g.collectionIds, collectionId];
          void run(() => api(`/api/admin/groups/${g.id}`, { method: "PATCH", body: JSON.stringify({ collectionIds }) }));
        }}
        onDelete={(g) => {
          if (!confirm(`Delete group "${g.name}"? Its ${g.members} member(s) lose the access it granted.`)) return;
          void run(() => api(`/api/admin/groups/${g.id}`, { method: "DELETE" }), `Group "${g.name}" deleted.`);
        }}
      />
    </div>
  );
}

function TempPassword({ email, password, onClose }: { email: string; password: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="status" className="rounded-xl border border-violet-400/30 bg-violet-500/10 p-4 text-sm text-white/85">
      <p className="font-medium text-white">Temporary password for {email}</p>
      <p className="mt-1 text-xs text-white/65">Share it privately (not in a group chat). It is shown only once; they&apos;ll choose their own password when they first sign in.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="rounded-lg bg-black/40 px-3 py-2 font-mono text-base tracking-wider text-white" data-testid="temp-password">{password}</code>
        <button type="button" className="btn btn-ghost h-9 px-3 text-[13px]" onClick={async () => setCopied(await navigator.clipboard?.writeText(password).then(() => true, () => false) ?? false)}>{copied ? "Copied" : "Copy"}</button>
        <button type="button" className="btn btn-ghost h-9 px-3 text-[13px]" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

function GroupChecks({ groups, value, onChange }: { groups: Group[]; value: string[]; onChange: (ids: string[]) => void }) {
  if (!groups.length) return <p className="text-xs text-faint">No groups yet. Create one under Groups &amp; access below.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {groups.map((g) => (
        <label key={g.id} className={`chip cursor-pointer ${value.includes(g.id) ? "border-violet-400/50 bg-violet-500/15 text-white" : ""}`}>
          <input type="checkbox" className="accent-violet-500" checked={value.includes(g.id)} onChange={(e) => onChange(e.target.checked ? [...value, g.id] : value.filter((x) => x !== g.id))} />
          {g.name}
        </label>
      ))}
    </div>
  );
}

function CreateUser({ groups, onCreate }: { groups: Group[]; onCreate: (input: { email: string; name: string; role: "ADMIN" | "MEMBER"; groupIds: string[] }) => Promise<boolean> }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"ADMIN" | "MEMBER">("MEMBER");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  return (
    <section className="glass rounded-2xl p-5">
      <h2 className="font-display text-lg font-semibold text-white">Add a person</h2>
      <form
        className="mt-4 space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          if (await onCreate({ email, name, role, groupIds })) {
            setEmail("");
            setName("");
            setRole("MEMBER");
            setGroupIds([]);
          }
          setBusy(false);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <label className="text-sm"><span className="mb-1.5 block text-white/65">Full name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="off" /></label>
          <label className="text-sm"><span className="mb-1.5 block text-white/65">Work email</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} autoComplete="off" /></label>
          <label className="text-sm"><span className="mb-1.5 block text-white/65">Role</span>
            <select className="input" value={role} onChange={(e) => setRole(e.target.value as "ADMIN" | "MEMBER")}><option value="MEMBER">Member</option><option value="ADMIN">Administrator</option></select>
          </label>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm text-white/65">Groups (decide what they can ask about)</legend>
          <GroupChecks groups={groups} value={groupIds} onChange={setGroupIds} />
        </fieldset>
        <button type="submit" disabled={busy} className="btn btn-primary h-10 px-4">{busy ? "Creating…" : "Create account"}</button>
      </form>
    </section>
  );
}

function UserRow(props: {
  u: User;
  self: boolean;
  groups: Group[];
  editing: boolean;
  onEdit: () => void;
  onSave: (patch: { name: string; role: "ADMIN" | "MEMBER"; groupIds: string[] }) => Promise<void>;
  onToggleDisabled: () => void;
  onReset: () => void;
}) {
  const { u, self } = props;
  const [name, setName] = useState(u.name);
  const [role, setRole] = useState(u.role);
  const [groupIds, setGroupIds] = useState(u.groups.map((g) => g.id));
  useEffect(() => {
    setName(u.name);
    setRole(u.role);
    setGroupIds(u.groups.map((g) => g.id));
  }, [u, props.editing]);
  return (
    <>
      <tr className={`border-t hairline ${u.disabled ? "opacity-60" : ""}`} data-testid="user-row">
        <td className="p-3"><div className="font-medium text-white">{u.name}{self && <span className="ml-2 text-xs text-faint">(you)</span>}</div><div className="text-xs text-faint">{u.email}</div></td>
        <td className="p-3">{u.role === "ADMIN" ? "Administrator" : "Member"}</td>
        <td className="p-3 text-xs">{u.groups.length ? u.groups.map((g) => g.name).join(", ") : <span className="text-amber-200">none (can&apos;t search anything)</span>}</td>
        <td className="p-3">
          {u.disabled ? <span className="badge bg-white/10 text-white/70">Disabled</span> : u.mustChangePassword ? <span className="badge bg-amber-400/10 text-amber-200">Awaiting first sign-in</span> : <span className="badge bg-emerald-400/10 text-emerald-200">Active</span>}
        </td>
        <td className="whitespace-nowrap p-3 text-right text-[13px]">
          <button type="button" className="mr-3 text-violet-300 hover:text-violet-200" aria-expanded={props.editing} aria-label={`Edit ${u.name}`} onClick={props.onEdit}>{props.editing ? "Close" : "Edit"}</button>
          <button type="button" className="mr-3 text-violet-300 hover:text-violet-200" aria-label={`Reset password for ${u.name}`} onClick={props.onReset}>Reset password</button>
          {!self && <button type="button" className={u.disabled ? "text-emerald-300 hover:text-emerald-200" : "text-rose-300 hover:text-rose-200"} aria-label={`${u.disabled ? "Enable" : "Disable"} ${u.name}`} onClick={props.onToggleDisabled}>{u.disabled ? "Enable" : "Disable"}</button>}
        </td>
      </tr>
      {props.editing && (
        <tr className="bg-white/[0.02]">
          <td colSpan={5} className="p-4">
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void props.onSave({ name, role, groupIds }); }}>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm"><span className="mb-1.5 block text-white/65">Full name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></label>
                <div className="text-sm">
                  <label className="block"><span className="mb-1.5 block text-white/65">Role</span>
                    <select className="input" value={role} disabled={self} onChange={(e) => setRole(e.target.value as "ADMIN" | "MEMBER")}><option value="MEMBER">Member</option><option value="ADMIN">Administrator</option></select>
                  </label>
                  {self && <p className="mt-1 text-xs text-faint">You can&apos;t change your own role.</p>}
                </div>
              </div>
              <fieldset><legend className="mb-1.5 text-sm text-white/65">Groups</legend><GroupChecks groups={props.groups} value={groupIds} onChange={setGroupIds} /></fieldset>
              <button type="submit" className="btn btn-primary h-9 px-4 text-[13px]">Save changes</button>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}

function GroupsPanel(props: { groups: Group[]; collections: Collection[]; onCreate: (name: string) => Promise<boolean>; onToggle: (g: Group, collectionId: string) => void; onDelete: (g: Group) => void }) {
  const [name, setName] = useState("");
  return (
    <section className="glass overflow-x-auto rounded-2xl">
      <div className="flex flex-wrap items-end gap-3 border-b hairline p-4">
        <div className="flex-1">
          <h2 className="font-display text-lg font-semibold text-white">Groups &amp; access</h2>
          <p className="text-xs text-faint">Tick the knowledge collections each group may search. Changes apply to the next question asked.</p>
        </div>
        <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (await props.onCreate(name.trim())) setName(""); }}>
          <input className="input !w-48" placeholder="New group name" aria-label="New group name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
          <button type="submit" className="btn btn-ghost h-10 px-3 text-[13px]">Add group</button>
        </form>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-white/[0.03] text-left text-[11px] uppercase tracking-wider text-faint">
          <tr><th className="p-3">Group</th>{props.collections.map((c) => <th key={c.id} className="p-3 text-center">{c.name}</th>)}<th className="p-3"><span className="sr-only">Actions</span></th></tr>
        </thead>
        <tbody>
          {props.groups.map((g) => (
            <tr key={g.id} className="border-t hairline">
              <td className="p-3"><div className="font-medium text-white">{g.name}</div><div className="text-xs text-faint">{g.members} member{g.members === 1 ? "" : "s"}</div></td>
              {props.collections.map((c) => (
                <td key={c.id} className="p-3 text-center">
                  <input type="checkbox" className="h-4 w-4 accent-violet-500" aria-label={`${g.name} can search ${c.name}`} checked={g.collectionIds.includes(c.id)} onChange={() => props.onToggle(g, c.id)} />
                </td>
              ))}
              <td className="p-3 text-right"><button type="button" className="text-[13px] text-rose-300 hover:text-rose-200" aria-label={`Delete group ${g.name}`} onClick={() => props.onDelete(g)}>Delete</button></td>
            </tr>
          ))}
          {!props.groups.length && <tr><td colSpan={props.collections.length + 2} className="p-6 text-center text-faint">No groups yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
