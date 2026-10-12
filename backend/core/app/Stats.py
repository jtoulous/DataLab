import math
import numpy as np



###############################################################################################
###############################################################################################
##########                                   Stats                                   ##########
#
# Lois et tests statistiques usuels, implementes directement (pas de dependance a scipy) :
#   - loi normale, loi de Student (via la fonction beta incomplete regularisee)
#   - test t de Welch, test de Kolmogorov-Smirnov a deux echantillons, taille d'effet


def normal_sf(z):
    """P(Z > z) pour Z ~ N(0, 1)."""
    return 0.5 * math.erfc(z / math.sqrt(2))


def _betacf(a, b, x, max_iter=300, eps=3e-14):
    """Fraction continue de la beta incomplete (Numerical Recipes, betacf)."""
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c, d = 1.0, 1.0 - qab * x / qap
    d = 1.0 / (d if abs(d) > 1e-300 else 1e-300)
    h = d
    for m in range(1, max_iter + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        d = 1.0 / (d if abs(d) > 1e-300 else 1e-300)
        c = 1.0 + aa / c if abs(1.0 + aa / c) > 1e-300 else 1e-300
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        d = 1.0 / (d if abs(d) > 1e-300 else 1e-300)
        c = 1.0 + aa / c if abs(1.0 + aa / c) > 1e-300 else 1e-300
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < eps:
            break
    return h


def betainc(a, b, x):
    """Beta incomplete regularisee I_x(a, b)."""
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    log_bt = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x)
    bt = math.exp(log_bt)
    if x < (a + 1) / (a + b + 2):
        return bt * _betacf(a, b, x) / a
    return 1.0 - bt * _betacf(b, a, 1 - x) / b


def t_two_sided_p(t, df):
    """p-value bilaterale d'une statistique t a `df` degres de liberte."""
    if df is None or df <= 0 or not np.isfinite(t):
        return None
    return betainc(df / 2.0, 0.5, df / (df + t * t))


def welch_t_test(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    na, nb = len(a), len(b)
    if na < 2 or nb < 2:
        return None
    va, vb = a.var(ddof=1), b.var(ddof=1)
    se = math.sqrt(va / na + vb / nb)
    if se == 0:
        return None
    t = (a.mean() - b.mean()) / se
    df = (va / na + vb / nb) ** 2 / ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1))
    pooled = math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2))
    return {
        't': float(t), 'df': float(df), 'p_value': t_two_sided_p(t, df),
        'mean_diff': float(a.mean() - b.mean()),
        'cohen_d': float((a.mean() - b.mean()) / pooled) if pooled > 0 else None,
    }


def ks_two_sample(a, b):
    """Statistique D de Kolmogorov-Smirnov et p-value asymptotique."""
    a, b = np.sort(np.asarray(a, float)), np.sort(np.asarray(b, float))
    na, nb = len(a), len(b)
    if na == 0 or nb == 0:
        return None
    values = np.concatenate([a, b])
    cdf_a = np.searchsorted(a, values, side='right') / na
    cdf_b = np.searchsorted(b, values, side='right') / nb
    d = float(np.max(np.abs(cdf_a - cdf_b)))
    n_eff = na * nb / (na + nb)
    lam = (math.sqrt(n_eff) + 0.12 + 0.11 / math.sqrt(n_eff)) * d
    p = 2 * sum((-1) ** (k - 1) * math.exp(-2 * k * k * lam * lam) for k in range(1, 101))
    return {'d': d, 'p_value': float(min(1.0, max(0.0, p)))}


def ols(y, X, names):
    """Regression lineaire multiple (avec constante) : coefficients, erreurs standard, t, p, R2."""
    n, k = X.shape
    design = np.column_stack([np.ones(n), X])
    coef, _, rank, _ = np.linalg.lstsq(design, y, rcond=None)
    fitted = design @ coef
    resid = y - fitted
    dof = n - k - 1
    sse = float(resid @ resid)
    sst = float(((y - y.mean()) ** 2).sum())
    sigma2 = sse / dof if dof > 0 else np.nan
    try:
        cov = sigma2 * np.linalg.inv(design.T @ design)
        se = np.sqrt(np.clip(np.diag(cov), 0, None))
    except np.linalg.LinAlgError:
        se = np.full(k + 1, np.nan)

    # coefficients standardises : effet d'un ecart-type de chaque variable, en ecarts-types de y
    std_x = X.std(axis=0, ddof=1)
    std_y = y.std(ddof=1)
    rows = []
    for i, name in enumerate(['(intercept)'] + list(names)):
        t = coef[i] / se[i] if se[i] > 0 else np.nan
        rows.append({
            'name': name, 'coef': float(coef[i]), 'se': float(se[i]), 't': float(t),
            'p_value': t_two_sided_p(t, dof) if np.isfinite(t) else None,
            'standardized': float(coef[i] * std_x[i - 1] / std_y) if i > 0 and std_y > 0 else None,
        })
    r2 = 1 - sse / sst if sst > 0 else np.nan
    return {
        'n': int(n), 'k': int(k), 'rank': int(rank),
        'r2': float(r2), 'adj_r2': float(1 - (1 - r2) * (n - 1) / dof) if dof > 0 else None,
        'rmse': float(math.sqrt(sse / n)), 'coefficients': rows,
        'fitted': fitted, 'residuals': resid,
    }
