#!/usr/bin/env bash
# Wrapper cho Linux. Chay: ./run.sh check   hoac  ./run.sh all
cd "$(dirname "$0")" || exit 1
[ -d node_modules ] || npm install
case "${1:-check}" in
  setup)   node setup-wallets.js "${2:-10}" ;;
  encrypt) node encrypt-keys.js ;;
  inspect) node inspect.js ;;
  check)   node run-all.js --check ;;
  all)     node run-all.js ;;
  reset)   node run-all.js --reset ;;
  *) echo "Dung: ./run.sh [setup N|encrypt|inspect|check|all|reset]" ;;
esac
