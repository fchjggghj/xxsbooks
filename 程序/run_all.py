from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
steps = [
    ROOT / 'scripts' / 'step1_break_outline.py',
    ROOT / 'scripts' / 'step2_adapt.py',
    ROOT / 'scripts' / 'step3_generate.py',
]
for step in steps:
    print(f'==> {step.name}')
    subprocess.check_call([sys.executable, str(step)], cwd=str(ROOT))
