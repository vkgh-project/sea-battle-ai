import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FLEET, LETTERS, SIZE, canPlace, key, label, randomFleet, same, touches, type AiMode, type GameView, type Point, type SessionView, type Ship, type Shot } from '../shared/game';
import './style.css';

class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Game-Request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error ?? 'Не вдалося виконати запит.', response.status);
  return data as T;
}
type BoardProps = {
  title: string; gameId?: string; ships: Ship[]; shots?: Shot[]; sunk?: Ship[];
  disabled?: boolean; onCell?: (p: Point) => void; preview?: Ship; previewValid?: boolean;
  onHover?: (p: Point | null) => void;
};
function Board({ title, gameId, ships, shots = [], sunk = [], disabled = false, onCell, preview = [], previewValid, onHover }: BoardProps) {
  const previous = useRef({ gameId, shots: new Set(shots.map(key)) });
  const [splashes, setSplashes] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    const last = previous.current;
    previous.current = { gameId, shots: new Set(shots.map(key)) };
    if (last.gameId !== gameId || shots.length === 0) {
      setSplashes(current => current.size ? new Set() : current);
      return;
    }
    const misses = shots.filter(shot => shot.result === 'miss' && !last.shots.has(key(shot)));
    if (misses.length && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setSplashes(current => new Set([...current, ...misses.map(key)]));
    }
  }, [gameId, shots]);
  const shipCells = new Set(ships.flat().map(key));
  const sunkCells = new Set(sunk.flat().map(key));
  return <section className="board-section">
    <h2>{title}</h2>
    <div className="board" onMouseLeave={() => onHover?.(null)}>
      <span />{[...LETTERS].map(letter => <span className="axis" key={letter}>{letter}</span>)}
      {Array.from({ length: SIZE }, (_, row) => <div className="board-row" key={row}>
        <span className="axis">{row + 1}</span>
        {Array.from({ length: SIZE }, (_, column) => {
          const p = { row, column };
          const shot = shots.find(s => same(s, p));
          const sunkCell = sunkCells.has(key(p));
          const blocked = sunk.some(ship => ship.some(q => touches(p, q)));
          const filled = shipCells.has(key(p));
          const previewCell = preview.some(q => same(p, q));
          const state = sunkCell ? 'sunk' : shot?.result === 'miss' ? 'miss' : shot ? 'hit' : filled ? 'ship' : blocked ? 'water' : '';
          const text = sunkCell ? 'потоплено' : shot?.result === 'miss' ? 'мимо' : shot ? 'влучання' : filled ? 'корабель' : blocked ? 'вода' : 'не обстріляно';
          return <button key={column} type="button"
            className={`cell ${state} ${previewCell ? previewValid ? 'preview' : 'invalid' : ''}`}
            aria-label={`${label(p)}: ${text}`} title={`${label(p)}: ${text}`}
            disabled={disabled || !onCell || (!!shot || blocked) && title === 'Поле суперника'}
            onClick={() => onCell?.(p)} onMouseEnter={() => onHover?.(p)} onFocus={() => onHover?.(p)}>
            {shot || sunkCell ? shot?.result === 'miss' ? '·' : '×' : blocked && !filled ? '·' : ''}
            {splashes.has(key(p)) && <span className="miss-splash" aria-hidden="true" onAnimationEnd={event => {
              if (event.animationName !== 'miss-splash-life') return;
              setSplashes(current => { const next = new Set(current); next.delete(key(p)); return next; });
            }}><span className="miss-ripple" /><span className="miss-droplets" /></span>}
          </button>;
        })}
      </div>)}
    </div>
  </section>;
}
function App() {
  const [game, setGame] = useState<GameView | null>(null);
  const [fleet, setFleet] = useState<Ship[]>(() => randomFleet());
  const [setup, setSetup] = useState(false);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<AiMode>('gemini');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [horizontal, setHorizontal] = useState(true);
  const [hover, setHover] = useState<Point | null>(null);
  const mounted = useRef(true);
  const requestLock = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void api<SessionView>('/session').then(session => {
      if (!cancelled) { setGame(session.game); setSetup(!session.game); setMode(session.aiMode); setReady(true); }
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Сервер недоступний.'); });
    return () => { cancelled = true; mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!game || setup || game.phase !== 'playing') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const epoch = generation.current;
      try {
        const next = await api<GameView>(`/game/${game!.id}`);
        if (!cancelled && epoch === generation.current && !requestLock.current) {
          setGame(current => current?.id === next.id && next.version >= current.version ? next : current);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Немає з’єднання.');
          if (e instanceof ApiError && (e.status === 401 || e.status === 404)) { setReady(false); return; }
        }
      }
      if (!cancelled) timer = setTimeout(poll, game!.busy ? 800 : 4000);
    }
    timer = setTimeout(poll, game.busy ? 500 : 4000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [game?.id, game?.busy, game?.phase, setup]);
  async function mutate(action: () => Promise<GameView>) {
    if (requestLock.current) return;
    requestLock.current = true;
    generation.current++;
    setLoading(true); setError('');
    try {
      const next = await action();
      if (mounted.current) { setGame(next); setSetup(false); }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Помилка з’єднання.');
      if (game) {
        try { const latest = await api<GameView>(`/game/${game.id}`); if (mounted.current) setGame(latest); } catch { /* Keep original actionable error. */ }
      }
    } finally { requestLock.current = false; if (mounted.current) setLoading(false); }
  }
  const nextLength = FLEET[fleet.length];
  const preview = hover && nextLength ? Array.from({ length: nextLength }, (_, i) => ({
    row: hover.row + (horizontal ? 0 : i), column: hover.column + (horizontal ? i : 0),
  })) : [];
  const finished = game && game.phase !== 'playing';
  const status = !ready ? 'Підключення до сервера…' : setup
    ? fleet.length === 10 ? 'Флот готовий. Починаймо?' : `Розмістіть корабель на ${nextLength} клітинки`
    : game?.phase === 'won' ? 'Ви перемогли! Увесь флот суперника потоплено.'
    : game?.phase === 'lost' ? 'AI переміг. Спробуємо ще раз?'
    : game?.turn === 'ai' ? game.busy ? 'AI обирає наступний постріл…' : 'Хід AI очікує повтору.'
    : 'Ваш хід. Оберіть клітинку на полі суперника.';
  return <main>
    <header><div className="eyebrow">ЛЮДИНА × {mode === 'demo' ? 'ДЕМО-БОТ' : 'GOOGLE GEMINI'}</div><h1>Морський бій<span>.</span></h1>
      <p className="intro">Десять кораблів. Сто клітинок. Один переможець.</p></header>
    <div className="status" role="status" aria-live="polite"><span className={`status-dot ${game?.busy ? 'pulse' : ''}`} />{status}</div>
    {mode === 'demo' && <p className="demo">Демонстраційний режим: ходи обирає локальний алгоритм.</p>}
    {error && <div className="error" role="alert">{error}{!ready && <button onClick={() => location.reload()}>Підключитися знову</button>}</div>}
    {!setup && game?.error && <div className="error" role="alert">{game.error}</div>}
    {!setup && game?.aiShots.length ? <p className="last-shot" role="status">
      Останній постріл {mode === 'demo' ? 'бота' : 'Gemini'}: {label(game.aiShots[game.aiShots.length - 1])} — {{ miss: 'мимо', hit: 'влучання', sunk: 'потоплено' }[game.aiShots[game.aiShots.length - 1].result]}.
    </p> : null}
    <div className="boards">
      <Board title="Ваш флот" gameId={game?.id} ships={setup ? fleet : game?.playerShips ?? []} shots={setup ? [] : game?.aiShots}
        sunk={setup ? [] : (game?.playerShips ?? []).filter(ship => ship.every(p => game?.aiShots.some(s => same(s, p))))}
        disabled={!setup || !ready || loading} preview={setup ? preview : []} previewValid={canPlace(preview, fleet)}
        onHover={setup ? setHover : undefined} onCell={setup ? p => {
          const existing = fleet.findIndex(ship => ship.some(q => same(p, q)));
          if (existing >= 0) { setFleet([]); setHover(null); return; }
          if (!nextLength) return;
          const ship = Array.from({ length: nextLength }, (_, i) => ({ row: p.row + (horizontal ? 0 : i), column: p.column + (horizontal ? i : 0) }));
          if (canPlace(ship, fleet)) { setFleet([...fleet, ship]); setError(''); }
          else setError('Корабель має бути в межах поля та не торкатися інших кораблів.');
        } : undefined} />
      <Board title="Поле суперника" gameId={game?.id} ships={game && !setup ? game.enemyShips ?? game.enemySunkShips : []}
        shots={setup ? [] : game?.playerShots} sunk={setup ? [] : game?.enemySunkShips}
        disabled={setup || !ready || loading || game?.turn !== 'human' || !!finished}
        onCell={game ? p => void mutate(() => api<GameView>(`/game/${game.id}/shot`, { ...p, version: game.version })) : undefined} />
    </div>
    <div className="actions">
      {setup ? <>
        <button className="primary" disabled={!ready || loading || fleet.length !== 10} onClick={() => void mutate(() => api<GameView>('/game', { ships: fleet }))}>Почати гру</button>
        <button disabled={loading} onClick={() => { setFleet(randomFleet()); setError(''); setHover(null); }}>Випадково</button>
        <button disabled={loading} onClick={() => { setFleet([]); setError(''); setHover(null); }}>Розставити вручну</button>
        {fleet.length < 10 && <button onClick={() => setHorizontal(!horizontal)}>{horizontal ? '↔ Горизонтально' : '↕ Вертикально'}</button>}
      </> : <>
        {game?.turn === 'ai' && !game.busy && !finished && <button className="primary" disabled={loading || !ready} onClick={() => void mutate(() => api<GameView>(`/game/${game.id}/retry`, {}))}>Повторити хід AI</button>}
        <button disabled={loading || game?.busy || !ready} onClick={() => {
          if (!finished && !window.confirm('Завершити поточну партію та почати нову?')) return;
          setFleet(randomFleet()); setSetup(true); setHover(null); setError('');
        }}>Нова гра</button>
      </>}
    </div>
    {setup && <p className="hint">Клік по полю — розмістити корабель. Клік по кораблю — очистити поле.</p>}
    {!setup && game && <p className="hint">Ваші постріли: {game.playerShots.length} · Потоплено: {game.enemySunkShips.length} / 10</p>}
    <div className="legend"><span><i className="ship" />Корабель</span><span><i className="hit" />Влучання</span><span><i className="sunk" />Потоплено</span><span>· Мимо</span></div>
    <details><summary>Правила гри</summary><p>Флот: один корабель на 4 клітинки, два на 3, три на 2 та чотири на 1. Кораблі стоять прямо й не торкаються навіть кутами. Після влучання стріляєте ще, після промаху хід переходить супернику. Перемагає той, хто першим потопить увесь чужий флот. AI бачить лише результати своїх пострілів.</p></details>
    <footer>Партії існують лише в пам’яті сервера. Перезапуск сервера або година бездіяльності завершує сесію.</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
