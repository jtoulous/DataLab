import os
import json
import sqlite3
from datetime import datetime, timezone



class DatabaseManager:
    """
    Metadonnees de l'application (SQLite) : datasets charges, colonnes derivees (formules) et
    espaces de travail par dataset. Les donnees elles-memes vivent en fichiers (DatasetStore).
    """

    def __init__(self, data_repo, datasets_tbl='datasets', columns_tbl='derived_columns', workspaces_tbl='workspaces'):
        self.DATA_REPO = data_repo
        self.DB_FILE = os.path.join(self.DATA_REPO, 'dataviz.db')
        self.DATASETS_TBL = datasets_tbl
        self.COLUMNS_TBL = columns_tbl
        self.WORKSPACES_TBL = workspaces_tbl

        os.makedirs(self.DATA_REPO, exist_ok=True)

        connection = sqlite3.connect(self.DB_FILE)
        connection.execute('PRAGMA journal_mode=WAL')
        connection.close()

        # Create datasets table
        query_1 = f'''
            CREATE TABLE IF NOT EXISTS {self.DATASETS_TBL} (
                dataset_id TEXT PRIMARY KEY,
                name TEXT,
                description TEXT,
                filename TEXT,
                file_size INTEGER,
                read_report TEXT,
                type_overrides TEXT,
                time_column TEXT,
                view_settings TEXT,
                profile TEXT,
                created_at TEXT,
                updated_at TEXT
            )
        '''

        # Create derived columns table
        query_2 = f'''
            CREATE TABLE IF NOT EXISTS {self.COLUMNS_TBL} (
                dataset_id TEXT,
                name TEXT,
                formula TEXT,
                description TEXT,
                created_at TEXT,
                PRIMARY KEY (dataset_id, name)
            )
        '''

        # Create workspaces table
        query_3 = f'''
            CREATE TABLE IF NOT EXISTS {self.WORKSPACES_TBL} (
                dataset_id TEXT,
                name TEXT,
                config TEXT,
                updated_at TEXT,
                PRIMARY KEY (dataset_id, name)
            )
        '''

        self.execute_queries([query_1, query_2, query_3])



    ##################################################################################################
    ##################################################################################################
    #####                                Basic SQL manip methods                                 #####

    def now_utc(self):
        return datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')

    def connect(self):
        return sqlite3.connect(self.DB_FILE, timeout=30)

    def execute_queries(self, queries):
        connection = None
        try:
            connection = self.connect()
            cursor = connection.cursor()
            for query in queries:
                if isinstance(query, tuple):
                    cursor.execute(*query)
                else:
                    cursor.execute(query)
            connection.commit()

        except sqlite3.Error as e:
            print(f"Erreur lors de l'exécution des requêtes : {e}")
            if connection:
                connection.rollback()
            raise

        finally:
            if connection:
                connection.close()


    def execute_query(self, query, params=()):
        connection = None
        try:
            connection = self.connect()
            cursor = connection.cursor()
            cursor.execute(query, params)
            results = cursor.fetchall()
            connection.commit()
            return results

        except sqlite3.Error as e:
            print(f"Erreur lors de l'exécution des requêtes : {e}")
            if connection:
                connection.rollback()
            raise

        finally:
            if connection:
                connection.close()

    #####                                                                                        #####
    ##################################################################################################
    ##################################################################################################



    ##################################################################################################
    ##################################################################################################
    #####                                        Datasets                                        #####

    DATASET_COLUMNS = ['dataset_id', 'name', 'description', 'filename', 'file_size', 'read_report', 'type_overrides',
                       'time_column', 'view_settings', 'profile', 'created_at', 'updated_at']
    JSON_FIELDS = {'read_report', 'type_overrides', 'view_settings', 'profile'}

    def _row_to_dataset(self, row, with_profile=True):
        record = dict(zip(self.DATASET_COLUMNS, row))
        for field in self.JSON_FIELDS:
            record[field] = json.loads(record[field]) if record[field] else None
        if not with_profile and record['profile']:
            profile = record['profile']
            types = {}
            for info in profile['columns'].values():
                types[info['type']] = types.get(info['type'], 0) + 1
            record['summary'] = {'rows': profile['rows'], 'columns': len(profile['columns']), 'types': types, 'time': profile.get('time')}
            record['profile'] = None
        return record

    def new_dataset(self, dataset_id, name, filename, file_size, read_report, profile):
        now = self.now_utc()
        self.execute_queries([(
            f'''INSERT INTO {self.DATASETS_TBL} ({", ".join(self.DATASET_COLUMNS)})
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (dataset_id, name, '', filename, file_size, json.dumps(read_report), json.dumps({}), 'auto',
             json.dumps({}), json.dumps(profile), now, now)
        )])

    def get_datasets_list(self):
        rows = self.execute_query(f'SELECT {", ".join(self.DATASET_COLUMNS)} FROM {self.DATASETS_TBL} ORDER BY updated_at DESC')
        return [self._row_to_dataset(r, with_profile=False) for r in rows]

    def get_dataset(self, dataset_id):
        rows = self.execute_query(f'SELECT {", ".join(self.DATASET_COLUMNS)} FROM {self.DATASETS_TBL} WHERE dataset_id = ?', (dataset_id,))
        return self._row_to_dataset(rows[0]) if rows else None

    def update_dataset(self, dataset_id, **fields):
        allowed = set(self.DATASET_COLUMNS) - {'dataset_id', 'created_at'}
        fields = {k: (json.dumps(v) if k in self.JSON_FIELDS else v) for k, v in fields.items() if k in allowed}
        fields['updated_at'] = self.now_utc()
        assignments = ', '.join(f'{k} = ?' for k in fields)
        self.execute_queries([(f'UPDATE {self.DATASETS_TBL} SET {assignments} WHERE dataset_id = ?', (*fields.values(), dataset_id))])

    def delete_dataset(self, dataset_id):
        self.execute_queries([
            (f'DELETE FROM {self.DATASETS_TBL} WHERE dataset_id = ?', (dataset_id,)),
            (f'DELETE FROM {self.COLUMNS_TBL} WHERE dataset_id = ?', (dataset_id,)),
            (f'DELETE FROM {self.WORKSPACES_TBL} WHERE dataset_id = ?', (dataset_id,)),
        ])

    #####                                                                                        #####
    ##################################################################################################
    ##################################################################################################



    ##################################################################################################
    ##################################################################################################
    #####                                    Derived columns                                     #####

    def get_columns(self, dataset_id):
        rows = self.execute_query(
            f'SELECT name, formula, description, created_at FROM {self.COLUMNS_TBL} WHERE dataset_id = ? ORDER BY created_at',
            (dataset_id,)
        )
        return {r[0]: {'formula': r[1], 'description': r[2], 'created_at': r[3]} for r in rows}

    def save_column(self, dataset_id, name, formula, description=''):
        self.execute_queries([(
            f'''INSERT INTO {self.COLUMNS_TBL} (dataset_id, name, formula, description, created_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(dataset_id, name) DO UPDATE SET formula = excluded.formula, description = excluded.description''',
            (dataset_id, name, formula, description or '', self.now_utc())
        )])

    def delete_column(self, dataset_id, name):
        self.execute_queries([(f'DELETE FROM {self.COLUMNS_TBL} WHERE dataset_id = ? AND name = ?', (dataset_id, name))])

    #####                                                                                        #####
    ##################################################################################################
    ##################################################################################################



    ##################################################################################################
    ##################################################################################################
    #####                                       Workspaces                                       #####

    def get_workspaces(self, dataset_id):
        rows = self.execute_query(
            f'SELECT name, updated_at FROM {self.WORKSPACES_TBL} WHERE dataset_id = ? ORDER BY updated_at DESC', (dataset_id,)
        )
        return [{'name': r[0], 'updated_at': r[1]} for r in rows]

    def get_workspace(self, dataset_id, name):
        rows = self.execute_query(
            f'SELECT config, updated_at FROM {self.WORKSPACES_TBL} WHERE dataset_id = ? AND name = ?', (dataset_id, name)
        )
        return {'name': name, 'config': json.loads(rows[0][0]), 'updated_at': rows[0][1]} if rows else None

    def save_workspace(self, dataset_id, name, config):
        self.execute_queries([(
            f'''INSERT INTO {self.WORKSPACES_TBL} (dataset_id, name, config, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(dataset_id, name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at''',
            (dataset_id, name, json.dumps(config), self.now_utc())
        )])

    def delete_workspace(self, dataset_id, name):
        self.execute_queries([(f'DELETE FROM {self.WORKSPACES_TBL} WHERE dataset_id = ? AND name = ?', (dataset_id, name))])

    #####                                                                                        #####
    ##################################################################################################
    ##################################################################################################
