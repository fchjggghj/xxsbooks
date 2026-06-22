from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]      # 项目根 novel_pipeline（data 在顶层）
APP_ROOT = Path(__file__).resolve().parents[1]  # 程序 文件夹（logs 在这）
INPUT_DIR = ROOT / 'data' / '01_broken_outlines'
OUTPUT_DIR = ROOT / 'data' / '02_adapted'
LOG_DIR = APP_ROOT / 'logs'

print('step2_adapt placeholder')
print('INPUT_DIR =', INPUT_DIR)
print('OUTPUT_DIR =', OUTPUT_DIR)
