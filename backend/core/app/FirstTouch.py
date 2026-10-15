import numpy as np

from .Engine import FormulaError



###############################################################################################
###############################################################################################
##########                          Premier niveau touche                            ##########
#
# Pour chaque ligne t : les deux niveaux (haut / bas) sont FIGES a leur valeur de la ligne t, puis on
# avance ligne par ligne a partir de t + 1 (au plus `horizon` lignes) :
#   - le niveau haut est touche quand la colonne "haute" l'atteint (>=)
#   - le niveau bas est touche quand la colonne "basse" l'atteint (<=)
# label = 1 si le haut est touche en premier, -1 si c'est le bas, 0 si aucun dans la limite.
# Les deux dans la meme ligne : l'ordre est inconnu -> le bas compte en premier (prudent pour un stop sous le prix).
# Pas assez de lignes apres t (fin des donnees ou d'un morceau) sans contact -> vide.
# On ne franchit jamais un raccord entre deux morceaux d'un sous-dataset.
# Generique : pour une seule serie de valeurs, mettre la meme colonne en haute et en basse.

MAX_HORIZON = 20_000


def first_touch(high, low, upper, lower, horizon, pieces, progress=None):
    """Tableaux numpy alignes. Renvoie (label, lignes jusqu'au contact) ; NaN = pas de label."""
    horizon = int(horizon)
    if horizon < 1 or horizon > MAX_HORIZON:
        raise FormulaError(f'The limit must be between 1 and {MAX_HORIZON:,} rows')
    n = len(high)
    label = np.full(n, np.nan)
    rows = np.full(n, np.nan)
    high = np.where(np.isfinite(high), high, -np.inf)       # valeur manquante : jamais un contact
    low = np.where(np.isfinite(low), low, np.inf)
    total = sum(b - a for a, b in pieces) or 1
    done = 0
    for a, b in pieces:
        idx = np.arange(a, b)
        pending = idx[np.isfinite(upper[idx]) & np.isfinite(lower[idx])]
        for k in range(1, horizon + 1):
            if not len(pending):
                break
            ahead = pending + k
            inside = ahead < b
            pending, ahead = pending[inside], ahead[inside]      # les autres n'ont plus de futur : restent vides
            hit_up = high[ahead] >= upper[pending]
            hit_down = low[ahead] <= lower[pending]
            down = pending[hit_down]                             # meme ligne : le bas compte en premier
            up = pending[hit_up & ~hit_down]
            label[down], rows[down] = -1, k
            label[up], rows[up] = 1, k
            pending = pending[~(hit_up | hit_down)]
        label[pending] = 0                                       # toute la limite parcourue, aucun contact
        done += b - a
        if progress:
            progress(done / total)
    return label, rows


def summarize(label, rows, upper, lower):
    decided = np.isfinite(label)
    count = int(decided.sum())
    share = lambda v: float((label[decided] == v).mean()) if count else 0.0
    touched = rows[np.isfinite(rows)]
    both = np.isfinite(upper) & np.isfinite(lower)
    return {
        'rows': int(len(label)), 'labelled': count, 'empty': int(len(label) - count),
        'up': share(1), 'down': share(-1), 'none': share(0),
        'median_rows': float(np.median(touched)) if len(touched) else None,
        'inverted': int((upper[both] < lower[both]).sum()),
    }
