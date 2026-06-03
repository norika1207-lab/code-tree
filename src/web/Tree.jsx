import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import ReactFlow, { Background, Controls, Handle, Position } from 'reactflow';
import 'reactflow/dist/style.css';
import { WS_PORT } from '../config.js';

const STATUS_COLOR = {
  idle: { bg: '#161b22', border: '#30363d', text: '#7d8590' },
  active: { bg: '#0f2417', border: '#2ea043', text: '#3fb950' }, // green = agent working
  modified: { bg: '#2b2412', border: '#bb8009', text: '#e3b341' }, // amber = edited
  error: { bg: '#2d1416', border: '#f85149', text: '#ff7b72' }, // red = repeated edits / something broke
};

// ── Custom node: shows filename, language, and edit-count dots, flashing on anomaly ──
function CellNode({ data }) {
  const c = STATUS_COLOR[data.status] || STATUS_COLOR.idle;
  const flashing = data.anomaly === 'repeat' || data.anomaly === 'error';
  const stalled = data.anomaly === 'stall';
  return (
    <div
      className={flashing ? 'ct-flash' : stalled ? 'ct-stall' : ''}
      style={{
        background: c.bg,
        border: `1.5px solid ${data.highlight ? '#58a6ff' : c.border}`,
        borderRadius: 8,
        padding: '8px 12px',
        minWidth: 150,
        color: c.text,
        boxShadow: data.highlight ? '0 0 0 2px #58a6ff55' : 'none',
        fontSize: 12,
      }}
      title={data.path}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}>
        {data.name}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, opacity: 0.8 }}>
        <span>{data.language} · {data.size_lines}L</span>
        <span>
          {Array.from({ length: Math.min(data.modification_count, 5) }).map((_, i) => (
            <span key={i} style={{ color: data.modification_count >= 3 ? '#ff7b72' : '#e3b341' }}>●</span>
          ))}
        </span>
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { cell: CellNode };

// Lay out in columns by directory depth (spec: root=entry, trunk=core modules, leaves=utils)
function layout(cells, edges, hovered) {
  const importers = new Set();
  if (hovered) for (const e of edges) if (e.to === hovered) importers.add(e.from);

  const byDepth = new Map();
  for (const cell of cells) {
    const d = cell.depth ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(cell);
  }
  const nodes = [];
  for (const [d, group] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    group.sort((a, b) => a.path.localeCompare(b.path));
    group.forEach((cell, i) => {
      nodes.push({
        id: cell.id,
        type: 'cell',
        position: { x: d * 280, y: i * 78 },
        data: {
          name: cell.path.split('/').pop(),
          path: cell.path,
          status: cell.status,
          language: cell.language,
          size_lines: cell.size_lines,
          modification_count: cell.modification_count,
          anomaly: cell.anomaly,
          highlight: hovered === cell.id || importers.has(cell.id),
        },
      });
    });
  }
  const flowEdges = edges.map((e) => {
    const hot = hovered && e.to === hovered;
    return {
      id: `${e.from}->${e.to}`,
      source: e.from,
      target: e.to,
      animated: hot,
      style: { stroke: hot ? '#58a6ff' : '#30363d', strokeWidth: hot ? 2 : 1 },
    };
  });
  return { nodes, flowEdges };
}

export function Tree() {
  const [state, setState] = useState({ cells: [], edges: [], root: '' });
  const [hovered, setHovered] = useState(null);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [feed, setFeed] = useState([]);
  const wsRef = useRef(null);

  useEffect(() => {
    let alive = true;
    function connect() {
      const ws = new WebSocket(`ws://localhost:${WS_PORT}`);
      wsRef.current = ws;
      ws.onopen = () => alive && setConnected(true);
      ws.onclose = () => {
        if (!alive) return;
        setConnected(false);
        setTimeout(connect, 1000); // auto-reconnect
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state') setState(msg.payload);
        else if (msg.type === 'activity') {
          setFeed((f) => [{ ...msg.payload, key: Math.random() }, ...f].slice(0, 12));
        } else if (msg.type === 'anomaly') {
          const t = { id: Math.random(), text: msg.payload.message };
          setToasts((ts) => [...ts, t]);
          setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== t.id)), 6000);
        }
      };
    }
    connect();
    return () => {
      alive = false;
      wsRef.current?.close();
    };
  }, []);

  const { nodes, flowEdges } = useMemo(
    () => layout(state.cells, state.edges, hovered),
    [state, hovered]
  );

  const onNodeMouseEnter = useCallback((_, node) => setHovered(node.id), []);
  const onNodeMouseLeave = useCallback(() => setHovered(null), []);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <style>{`
        @keyframes ctflash { 0%,100%{box-shadow:0 0 0 0 #f8514900} 50%{box-shadow:0 0 16px 3px #f85149cc} }
        .ct-flash { animation: ctflash 1s ease-in-out infinite; }
        @keyframes ctstall { 0%,100%{opacity:1} 50%{opacity:.45} }
        .ct-stall { animation: ctstall 1.6s ease-in-out infinite; filter: grayscale(.6); }
      `}</style>

      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        fitView
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#21262d" gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>

      {/* Top-left: title + connection status */}
      <div style={{ position: 'absolute', top: 14, left: 14, color: '#e6edf3', pointerEvents: 'none' }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Cosmos Tree</div>
        <div style={{ fontSize: 11, color: '#7d8590' }}>{state.root}</div>
        <div style={{ fontSize: 11, marginTop: 2, color: connected ? '#3fb950' : '#f85149' }}>
          {connected ? `● connected · ${state.cells.length} nodes` : '○ waiting for core...'}
        </div>
      </div>

      {/* Top-right: activity feed */}
      <div style={{ position: 'absolute', top: 14, right: 14, width: 280, color: '#7d8590', fontSize: 11 }}>
        {feed.map((a) => (
          <div key={a.key} style={{ opacity: 0.9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ color: a.action === 'modify' ? '#e3b341' : a.action === 'create' ? '#3fb950' : '#58a6ff' }}>
              {a.action}
            </span>{' '}
            {a.path} {a.count >= 3 ? `(×${a.count})` : ''}
          </div>
        ))}
      </div>

      {/* Anomaly toast */}
      <div style={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', width: 460 }}>
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              background: '#2d1416', border: '1px solid #f85149', color: '#ff7b72',
              padding: '10px 14px', borderRadius: 8, marginTop: 8, fontSize: 13,
            }}
          >
            ⚠ {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
