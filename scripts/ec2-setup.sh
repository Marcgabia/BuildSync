#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu EC2 instance.
# Usage (on the server, inside the cloned repo):  bash scripts/ec2-setup.sh
set -euo pipefail

# 1. Docker Engine + Compose plugin
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

# 2. 2 GB swap so MySQL + Node fit comfortably on small instances
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# 3. .env with strong random passwords (only created if missing)
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|^MYSQL_PASSWORD=.*|MYSQL_PASSWORD=$(openssl rand -hex 24)|" .env
  sed -i "s|^MYSQL_ROOT_PASSWORD=.*|MYSQL_ROOT_PASSWORD=$(openssl rand -hex 24)|" .env
  sed -i "s|^APP_BIND_ADDRESS=.*|APP_BIND_ADDRESS=0.0.0.0|" .env
  sed -i "s|^APP_PORT=.*|APP_PORT=8080|" .env
  chmod 600 .env
  echo "Created .env (public on port 8080, random database passwords)."
fi

echo
echo "Setup done. Log out and back in (so the docker group applies), then run:"
echo "  docker compose up -d --build"
