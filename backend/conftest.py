"""Lets pytest find the "app" package from any folder, e.g. "pytest backend" from the repo root."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
