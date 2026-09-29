import { useState } from 'react';

export default function RoomCard({ room, users, onSaveMembers, onClearHistory }) {
  const [selected, setSelected] = useState(room.members.map((m) => m.id));
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  const toggle = (userId) => {
    setSelected((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  const saveMembers = async () => {
    setSaving(true);
    try {
      await onSaveMembers(room.id, selected);
    } finally {
      setSaving(false);
    }
  };

  const clearHistory = async () => {
    const ok = await window.confirmAsync(`Clear all history for room "${room.name}"?`);
    if (!ok) return;
    setClearing(true);
    try {
      await onClearHistory(room.id);
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">{room.name}</h3>
          <p className="text-xs text-slate-400">
            Members: {room.members_count} · Messages: {room.messages_count}
          </p>
        </div>
        <button
          onClick={clearHistory}
          disabled={clearing}
          className="rounded bg-red-700 px-3 py-1 text-sm text-white hover:bg-red-600 disabled:opacity-60"
        >
          {clearing ? 'Clearing...' : 'Clear History'}
        </button>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        {users.map((user) => (
          <label key={user.id} className="flex items-center gap-2 rounded bg-slate-800 px-2 py-1 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(user.id)}
              onChange={() => toggle(user.id)}
            />
            <span>
              {user.username}
              {user.is_admin ? ' (admin)' : ''}
            </span>
          </label>
        ))}
      </div>

      <button
        onClick={saveMembers}
        disabled={saving}
        className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60"
      >
        {saving ? 'Saving...' : 'Save Room Members'}
      </button>
    </div>
  );
}
