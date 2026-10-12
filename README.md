# 📊 DataViz

Exploratory analysis workbench for any tabular dataset: load a file in any format, check how
its columns were understood, then explore, visualize and test.

Same stack and structure as Anomaly Sentinel / Claude Trading (FastAPI managers + React 19 / Vite),
on its own ports: **backend 8010, frontend 8011** (it can run alongside Claude Trading on 8000/8001).


## Launch

```bash
make            # docker: backend :8010, frontend :8011 — data in /goinfre/$USER/DataViz/data if it exists
# without docker
make install && make backend      # terminal 1
make frontend                     # terminal 2
```


## Loading (backend/core/app/DataLoader.py)

No imposed format. Supported: CSV / TSV / TXT / DAT, Excel (xlsx, xls — the most populated sheet), Parquet,
Feather, JSON (records, columns, JSON lines, nested objects flattened).

Detected automatically for text files: encoding (utf-8, cp1252, latin-1…), separator (`, ; tab | :` or spaces),
header row, malformed lines.

Each column is then **categorized** and converted:

| Type | Detected from |
|---|---|
| `datetime` | native dates, text dates (ISO, day/month or month/day — decided from unambiguous values), Unix timestamps (s/ms/µs/ns) in a time-named column |
| `numeric` | numbers, including decimal comma, thousands separators, `%` (→ ratio), currency signs, `(12)` negatives |
| `boolean` | true/false, yes/no, oui/non, t/f… (stored as 1 / 0) |
| `categorical` | text with a limited set of values |
| `text` / `identifier` | free text / one unique value per row |

Values that fail conversion become empty and are counted (shown as warnings). Every type can be overridden
in the **Overview** tab (or a column ignored). Column names are normalized into formula-friendly identifiers
(`Pressure (bar)` → `pressure_bar`), the original name is kept as a label.

The **time axis** is chosen automatically (datetime column, preferably time-named) or by hand; the data is
sorted on it, and its step, regularity, gaps and duplicates are reported.


## Tabs

- **Overview** — file reading report, time axis, every column with type, detection notes, missing values,
  uniques, distribution and summary; type overrides.
- **Data** — paginated / sortable grid, column chooser, CSV export of what you see.
- **Explore** — derived columns (formulas, live preview) + 19 analysis panels, saveable workspaces.

A **view** (date / row range, resampling, row filter formula) is saved per dataset and applies to Data and Explore.


## Formulas (backend/core/app/Engine.py)

Python-like expressions, evaluated safely (AST whitelist, nothing is executed):
`(price - mean(price, 50)) / std(price, 50)`, `mean(load, "7D")` (duration windows with a time axis),
`where(status == "OK", value, 0)`, `hour()`, `crossup(a, b)`, `lag(x, 3)`, … The full list is in the
Explore sidebar. `lead(x, n)` reads FOLLOWING rows: such columns are flagged **LOOKAHEAD** (targets to
explain, never inputs).


## Analyses

Line chart · descriptive stats · distribution · box plots · two-group comparison (Welch t-test, Kolmogorov-Smirnov,
Cohen d) · scatter · scatter matrix · correlation matrix · lead/lag correlation · linear regression (coefficients,
p-values, R²) · PCA · group & aggregate · pivot heatmap · calendar heatmap · autocorrelation (ACF / PACF) ·
conditional mean by deciles (permutation test, stability per period) · event study (vs random rows) ·
runs & durations (survival analysis vs shuffled data) · missing values map.

Statistical tests are implemented in `backend/core/app/Stats.py` (no scipy dependency) and checked against
reference values.
