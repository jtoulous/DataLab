import os
import sys
import shutil
import uvicorn
import argparse as ap

from core.ServerManager import ServerManager



DATA_PATH = os.environ.get('DATA_PATH', 'data')
PORT = 8010
HOST = "0.0.0.0"

server_manager = ServerManager(DATA_PATH, host=HOST, port=PORT)
server = server_manager.server



def Parsing():
    parser = ap.ArgumentParser()
    parser.add_argument('usage', type=str, help='run_dev, run, reset')
    return parser.parse_args() 



if __name__ == '__main__':
    try:
        args = Parsing()

        if args.usage == 'run_dev':
            uvicorn.run("backend:server", host=HOST, port=PORT, reload=True, reload_dirs=["core"])

        elif args.usage == 'run':
            server_manager.run()

        elif args.usage == 'reset':
            shutil.rmtree(DATA_PATH)

        else:
            raise Exception('Unknown type of usage for the backend')

    except Exception as error:
        print(f'Error: {error}', flush=True)
        sys.exit(1)
