#!/usr/bin/env bash
# AariNAT Sniper — one-paste setup for a FRESH Ubuntu 22.04 server (x86 or ARM).
# Needs only a Telegram bot token + chat id. Paper trading. Safe to re-run.
set -e
echo "== 1/6 packages"
sudo apt-get update -y
sudo apt-get install -y curl git build-essential

echo "== 2/6 Node 20 + PM2"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo npm install -g pm2

echo "== 3/6 swap (safety net on small servers)"
if [ "$(free -m | awk '/^Mem:/{print $2}')" -lt 2000 ] && [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "== 4/6 code"
cd ~
[ -d KBE-MEME-TOKENS ] || git clone https://github.com/KobOmoba/KBE-MEME-TOKENS.git
cd KBE-MEME-TOKENS
git fetch origin && git checkout v4.2-watchlist && git pull origin v4.2-watchlist
npm install --no-audit --no-fund

echo "== 5/6 settings (.env)"
if [ ! -f .env ]; then
  read -r -p "Telegram BOT TOKEN: " TG_TOKEN
  read -r -p "Telegram CHAT ID: " TG_CHAT
  cat > .env <<ENVEOF
PAPER_TRADE=true
AUTO_TRADE=false
TELEGRAM_BOT_TOKEN=$TG_TOKEN
TELEGRAM_CHAT_ID=$TG_CHAT
ENVEOF
  chmod 600 .env
else
  echo ".env already exists — keeping it"
fi

echo "== 6/6 start"
pm2 delete scanner 2>/dev/null || true
pm2 start index.js --name scanner --max-memory-restart 700M
pm2 save
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$USER" --hp "$HOME" | tail -1 | sudo bash || true
pm2 save
echo "DONE. Telegram should show 'AariNAT Sniper V4 — STARTED' within a minute."
