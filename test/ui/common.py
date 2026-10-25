# Shared paths for the UI regression tests.
import os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))   # the app (served as-is)
OUT = os.environ.get('BURNPLAN_SHOTS', os.path.join(os.path.dirname(__file__), 'shots'))  # screenshots (gitignored)
os.makedirs(OUT, exist_ok=True)
