import { SIZE, inside, key, same, touches, type Point, type Ship } from '../shared/game.js';
import type { knowledge } from './engine.js';
type Knowledge = ReturnType<typeof knowledge>;
export type TargetPlan = { mode: 'pursuit' | 'search'; targets: Point[] };

// Use only the AI's public shot history. Never inspect the player's hidden fleet.
export function planTargets(state: Knowledge): TargetPlan {
  const available = new Map(state.availableTargets.map(p => [key(p), p]));
  const sunk = new Set(state.sunkShips.flat().map(key));
  const hits = state.shots.filter(s => s.result !== 'miss' && !sunk.has(key(s)));
  const hitKeys = new Set(hits.map(key));
  const lengths = new Map<number, number>();
  for (const length of state.remainingShips) lengths.set(length, (lengths.get(length) ?? 0) + 1);
  const groups: Ship[] = [];
  const ungrouped = new Map(hits.map(p => [key(p), p]));
  while (ungrouped.size) {
    const first = ungrouped.values().next().value!;
    const group: Ship = [first];
    ungrouped.delete(key(first));
    for (let i = 0; i < group.length; i++) {
      for (const p of ungrouped.values()) {
        if (Math.abs(p.row - group[i].row) + Math.abs(p.column - group[i].column) === 1) {
          group.push(p); ungrouped.delete(key(p));
        }
      }
    }
    groups.push(group);
  }
  const placements = (length: number): Ship[] => {
    const result: Ship[] = [];
    for (let row = 0; row < SIZE; row++) for (let column = 0; column < SIZE; column++) {
      for (const horizontal of length === 1 ? [true] : [true, false]) {
        const ship = Array.from({ length }, (_, i) => ({ row: row + (horizontal ? 0 : i), column: column + (horizontal ? i : 0) }));
        if (!ship.every(p => inside(p) && (available.has(key(p)) || hitKeys.has(key(p))))) continue;
        if (ship.some(p => state.sunkShips.some(other => other.some(q => touches(p, q))))) continue;
        // Any known hit touching this placement must be part of this same ship.
        if (hits.some(h => ship.some(p => touches(h, p)) && !ship.some(p => same(h, p)))) continue;
        if (state.remainingShips.length === 1 && !hits.every(h => ship.some(p => same(h, p)))) continue;
        if (!ship.some(p => available.has(key(p)))) continue; // A completed ship cannot remain unresolved.
        result.push(ship);
      }
    }
    return result;
  };
  const byLength = new Map([...lengths.keys()].map(length => [length, placements(length)]));
  const scores = new Map<number, number>();
  if (groups.length) {
    for (const group of groups) {
      const candidates: { ship: Ship; weight: number }[] = [];
      for (const [length, count] of lengths) {
        if (length <= group.length) continue;
        const fits = byLength.get(length)!.filter(ship => group.every(h => ship.some(p => same(h, p))));
        // Condition the placement probabilities on all observed hits in this group.
        for (const ship of fits) candidates.push({ ship, weight: count });
      }
      const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
      if (!total) continue;
      for (const p of available.values()) {
        // Only immediate continuations of a damaged ship, never a distant cell or a diagonal.
        if (!group.some(h => Math.abs(p.row - h.row) + Math.abs(p.column - h.column) === 1)) continue;
        const score = candidates.reduce((sum, candidate) => sum + (candidate.ship.some(q => same(p, q)) ? candidate.weight : 0), 0) / total;
        if (score > 0) scores.set(key(p), Math.max(scores.get(key(p)) ?? 0, score));
      }
    }
  } else {
    for (const [length, count] of lengths) {
      const fits = byLength.get(length)!;
      for (const ship of fits) for (const p of ship) {
        scores.set(key(p), (scores.get(key(p)) ?? 0) + count / fits.length);
      }
    }
  }
  const best = Math.max(0, ...scores.values());
  const targets = [...available.values()].filter(p => best > 0 && Math.abs((scores.get(key(p)) ?? 0) - best) < 1e-10);
  return { mode: groups.length ? 'pursuit' : 'search', targets };
}

export function shuffledTargets(targets: Point[]): Point[] {
  const result = [...targets];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
