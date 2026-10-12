
# Donnees (fichiers charges + base de metadonnees) hors du /home quand /goinfre existe
DV_DATA_DIR ?= $(if $(wildcard /goinfre/$(USER)),/goinfre/$(USER)/DataViz/data,$(CURDIR)/data)
export DV_DATA_DIR

ifeq ($(OS),Windows_NT)
    RM = powershell -Command "Remove-Item -Recurse -Force data"
    START_DOCKER = powershell -Command "if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) { Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'; Write-Host ' Starting de Docker Desktop...'; Start-Sleep -Seconds 10 } else { Write-Host ' Docker already started.' }"
else
    RM = rm -rf $(DV_DATA_DIR)
    START_DOCKER = echo "✅ Docker already started."
endif


all: up

up:
	@$(START_DOCKER)
	@mkdir -p $(DV_DATA_DIR)
	@echo "📦 Data: $(DV_DATA_DIR)"
	@docker compose up

down:
	@docker compose down

reset:
	@docker compose down
	@docker system prune -af
	@$(RM)


# ── Sans docker ──────────────────────────────────────────
install:
	@python3 -m venv venv
	@./venv/bin/pip install -r backend/requirements.txt
	@cd frontend && npm install

backend:
	@mkdir -p $(DV_DATA_DIR)
	@cd backend && DATA_PATH=$(DV_DATA_DIR) ../venv/bin/python backend.py run_dev

frontend:
	@cd frontend && npm run dev


.PHONY: up down reset install backend frontend
