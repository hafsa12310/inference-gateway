.PHONY: up down logs test lint clean

up:
	docker compose up -d --build
down:
	docker compose down
logs:
	docker compose logs -f
test:
	cd gateway && npm test
	cd worker && uv run pytest
lint:
	cd gateway && npm run lint
	cd worker && uv run ruff check . && uv run ruff format --check .
	cd autoscaler && uv run ruff check .
clean:
	docker compose down -v --remove-orphans
