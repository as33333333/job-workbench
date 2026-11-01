#!/usr/bin/env bash
# 一键采集：深圳 · 产品经理 · 1-3年 · 本科，输出到 ~/.boss-zhipin-scraper/job-result/
# 首次使用前需先执行一次登录配置（见 README 或 岗位库→采集指南）：
#   cd collector/boss-zhipin-scraper && python3 scripts/boss_cdp_raw.py --setup-chrome
set -e
cd "$(dirname "$0")/../collector/boss-zhipin-scraper"
CITY="${CITY:-深圳}"
KEYWORD="${KEYWORD:-产品经理}"
EXP="${EXP:-104}"     # 103=1年内 104=1-3年 105=3-5年 106=5-10年 101=不限
DEGREE="${DEGREE:-203}"  # 202=大专 203=本科 204=硕士
exec python3 scripts/boss_cdp_raw.py --city "$CITY" --keyword "$KEYWORD" --experience "$EXP" --degree "$DEGREE"
