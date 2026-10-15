"""
Verifie le label "premier niveau touche" contre une version naive ligne par ligne.
    cd backend && python tests/test_first_touch.py
"""
import os
import sys
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from core.app.FirstTouch import first_touch


def naive(high, low, upper, lower, horizon, pieces):
    n = len(high)
    label, rows = np.full(n, np.nan), np.full(n, np.nan)
    for a, b in pieces:
        for t in range(a, b):
            if not (np.isfinite(upper[t]) and np.isfinite(lower[t])):
                continue
            for k in range(1, horizon + 1):
                j = t + k
                if j >= b:
                    break                                   # plus de futur : vide
                up = np.isfinite(high[j]) and high[j] >= upper[t]
                down = np.isfinite(low[j]) and low[j] <= lower[t]
                if down:
                    label[t], rows[t] = -1, k
                    break
                if up:
                    label[t], rows[t] = 1, k
                    break
            else:
                label[t] = 0
    return label, rows


def check(name, condition, detail=''):
    print(f'{"OK  " if condition else "FAIL"} {name} {detail}')
    return condition


def main():
    ok = True
    rng = np.random.default_rng(0)
    n = 3000
    close = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, n)))
    high, low = close * (1 + rng.random(n) * 0.01), close * (1 - rng.random(n) * 0.01)
    high[rng.random(n) < 0.02] = np.nan                     # valeurs manquantes
    upper, lower = close * 1.02, close * 0.985
    upper[rng.random(n) < 0.01] = np.nan
    pieces = [(0, 1200), (1200, 1210), (1210, 3000)]        # un sous-dataset en 3 morceaux
    for horizon in (1, 7, 50):
        got = first_touch(high, low, upper, lower, horizon, pieces)
        want = naive(high, low, upper, lower, horizon, pieces)
        same = all(np.array_equal(g, w, equal_nan=True) for g, w in zip(got, want))
        ok &= check(f'matches the row-by-row version (limit {horizon})', same,
                    f'up {np.mean(got[0] == 1):.2f} down {np.mean(got[0] == -1):.2f} none {np.mean(got[0] == 0):.2f} empty {np.isnan(got[0]).mean():.2f}')

    # cas faits a la main : une seule serie (haute = basse)
    v = np.array([10, 10.5, 11, 9, 10, 10, 10.0])
    label, rows = first_touch(v, v, v + 1, v - 1, 3, [(0, len(v))])
    ok &= check('single series: 10 -> 11 first = upper', label[0] == 1 and rows[0] == 2, f'{label[0]} in {rows[0]} rows')
    ok &= check('single series: 11 -> 9 first = lower', label[2] == -1 and rows[2] == 1)
    flat = np.full(6, 10.0)
    flat_label, _ = first_touch(flat, flat, flat + 1, flat - 1, 2, [(0, 6)])
    ok &= check('nothing within the limit = 0', flat_label[0] == 0 and flat_label[3] == 0 and np.isnan(flat_label[4]), f'{flat_label}')
    ok &= check('not enough rows left = empty', np.isnan(label[-1]) and np.isnan(label[-2]))

    # les deux niveaux dans la meme ligne : le bas compte en premier
    high = np.array([100, 103.0, 100])
    low = np.array([100, 97.0, 100])
    label, _ = first_touch(high, low, np.array([102.0] * 3), np.array([98.0] * 3), 2, [(0, 3)])
    ok &= check('both in the same row: lower first', label[0] == -1)

    # aucun raccord franchi : la derniere ligne d'un morceau n'a pas de futur
    v = np.array([1, 1, 5, 5.0])
    label, _ = first_touch(v, v, v + 1, v - 1, 3, [(0, 2), (2, 4)])
    ok &= check('never crosses a seam between pieces', np.isnan(label[1]) and np.isnan(label[0]), f'{label}')

    print('\nALL OK' if ok else '\nSOME TESTS FAILED')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
