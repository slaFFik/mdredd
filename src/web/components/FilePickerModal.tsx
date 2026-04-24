import { useCallback, useEffect, useState } from 'react';
import { fsList, fsRead, type FsEntry } from '../lib/api.js';

export function FilePickerModal(props: {
  open: boolean;
  onClose: () => void;
  onPick: (relPath: string, content: string) => void;
}): JSX.Element | null {
  const [currentPath, setCurrentPath] = useState<string>('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fsList(path);
      setCurrentPath(res.path);
      setEntries(res.entries);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (props.open) void load('');
  }, [props.open, load]);

  const pickFile = useCallback(
    async (entry: FsEntry) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fsRead(entry.path);
        props.onPick(res.path, res.content);
        props.onClose();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [props],
  );

  if (!props.open) return null;

  const segments = currentPath ? currentPath.split('/') : [];

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal file-picker" onClick={(e) => e.stopPropagation()}>
        <h3>Pick a file from your project</h3>
        <div className="breadcrumb">
          <button type="button" onClick={() => void load('')} disabled={!currentPath}>
            cwd
          </button>
          {segments.map((seg, i) => {
            const path = segments.slice(0, i + 1).join('/');
            const isLast = i === segments.length - 1;
            return (
              <span key={path}>
                <span className="sep">/</span>
                <button
                  type="button"
                  onClick={() => void load(path)}
                  disabled={isLast}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>
        {error && <div className="picker-error">{error}</div>}
        <div className="picker-list">
          {loading && <div className="empty-hint">Loading…</div>}
          {!loading && entries.length === 0 && !error && (
            <div className="empty-hint">(empty)</div>
          )}
          {!loading && currentPath && (
            <button
              type="button"
              className="picker-entry"
              onClick={() => void load(parentOf(currentPath))}
            >
              <span className="icon">↩</span>
              <span className="name">..</span>
            </button>
          )}
          {!loading &&
            entries.map((e) => (
              <button
                key={e.path}
                type="button"
                className={`picker-entry ${e.isDirectory ? 'dir' : 'file'}`}
                onClick={() => (e.isDirectory ? void load(e.path) : void pickFile(e))}
                title={e.path}
              >
                <span className="icon">{e.isDirectory ? '▸' : '·'}</span>
                <span className="name">{e.name}</span>
                {!e.isDirectory && <span className="size">{formatSize(e.size)}</span>}
              </button>
            ))}
        </div>
        <div className="actions">
          <button onClick={props.onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return '';
  return path.slice(0, idx);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
