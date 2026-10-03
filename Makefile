.PHONY: help dev test build fmt lint up down logs capture mqtt-user

help:
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n",$$1,$$2}'

test: ## Run every test (Go with race detector, then the frontend)
	cd backend && go test -race -cover ./...
	cd frontend && npm run typecheck && npm test

fmt: ## Format Go sources
	cd backend && gofmt -w ./cmd ./internal

lint: ## Vet Go and typecheck the frontend
	cd backend && go vet ./...
	cd frontend && npm run typecheck

build: ## Build both binaries
	cd backend && go build -o ../bin/relayd ./cmd/relayd
	cd frontend && npm run build

dev: ## Run the backend with no database and no broker (replay file optional)
	cd backend && MESHQUAL_LOG_LEVEL=debug MESHQUAL_CORS_ORIGINS=http://localhost:5173 \
		go run ./cmd/relayd

up: ## Start the whole stack
	@# mosquitto refuses to start without its password file, even an empty one.
	@touch deploy/mosquitto/passwd
	docker compose up -d --build

down: ## Stop the stack
	docker compose down

logs: ## Follow the backend logs
	docker compose logs -f relayd

capture: ## Record live MQTT traffic to an NDJSON replay file
	@echo "mosquitto_sub -h mqtt.comchan.net -p 8883 --capath /etc/ssl/certs \\"
	@echo "  -u mc_uplink -P mc_uplink -t 'meshcore/+/+/packets' -F '{\"topic\":\"%t\",\"payload\":%p}' > capture.ndjson"

mqtt-user: ## Add or change a broker account (prompts for the password): make mqtt-user NAME=alice
	@test -n "$(NAME)" || { echo "usage: make mqtt-user NAME=<username>"; exit 1; }
	@touch deploy/mosquitto/passwd
	docker compose exec mosquitto mosquitto_passwd /mosquitto/config/passwd $(NAME)
	@# The broker runs as the mosquitto user, so the file must stay readable by it.
	@# chown fails on Docker Desktop bind mounts; the file then keeps its 0644 mode.
	-docker compose exec mosquitto sh -c 'chown mosquitto:mosquitto /mosquitto/config/passwd && chmod 0600 /mosquitto/config/passwd'
	docker compose kill -s HUP mosquitto
